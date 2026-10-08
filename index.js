'use strict';

const {
  Client, GatewayIntentBits, Events, ChannelType,
  PermissionFlagsBits: P, SlashCommandBuilder, MessageFlags,
} = require('discord.js');

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus: V,
} = require('@discordjs/voice');

const guildId = process.env.DISCORD_GUILD_ID?.trim();

const allowed = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
);

if (!/^\d{17,20}$/.test(guildId || '')) {
  throw new Error('DISCORD_GUILD_ID invalide.');
}

if (
  !allowed.size ||
  [...allowed].some(id => !/^\d{17,20}$/.test(id))
) {
  throw new Error(
    'ALLOWED_USER_IDS doit contenir vos identifiants Discord, séparés par des virgules.'
  );
}

const tokens = [];

for (let i = 1; i <= 30; i++) {
  const token = process.env[`BOT_TOKEN_${i}`]?.trim();
  if (token) tokens.push(token);
}

if (!tokens.length || new Set(tokens).size !== tokens.length) {
  throw new Error(
    'Ajoute BOT_TOKEN_1 puis les autres jetons, tous différents.'
  );
}

let ready = false;
let busy = false;
let stopping = false;

const actors = tokens.map((token, index) => ({
  token,
  index,
  connection: null,
  channelId: null,
  timer: null,
  client: new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  }),
}));

const controller = actors[0].client;

const command = new SlashCommandBuilder()
  .setName('netcord-live')
  .setDescription('Piloter les présences Netcord dans un live')
  .setDefaultMemberPermissions(P.ManageGuild)
  .addSubcommand(s =>
    s.setName('rejoindre')
      .setDescription('Connecter tous les bots au live')
      .addChannelOption(o =>
        o.setName('salon')
          .setDescription('Salon vocal ou Stage')
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildVoice,
            ChannelType.GuildStageVoice
          )
      )
  )
  .addSubcommand(s =>
    s.setName('quitter')
      .setDescription('Déconnecter tous les bots')
  );

function logError(label, error) {
  // Ne pas afficher les objets d’erreur pouvant contenir des secrets.
  console.error(
    `${label}: ${error?.code || error?.name || 'Erreur'}`
  );
}

function disconnect(actor) {
  clearTimeout(actor.timer);
  actor.timer = null;

  const old = actor.connection;
  actor.connection = null;
  actor.channelId = null;

  if (old && old.state.status !== V.Destroyed) {
    old.destroy();
  }
}

const delay = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function join(actor, channelId) {
  const guild = actor.client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Serveur inaccessible');

  const channel = await guild.channels.fetch(channelId);
  const me = await guild.members.fetchMe();

  if (
    ![
      ChannelType.GuildVoice,
      ChannelType.GuildStageVoice,
    ].includes(channel?.type) ||
    !channel.permissionsFor(me)?.has([P.ViewChannel, P.Connect]) ||
    !channel.joinable
  ) {
    throw new Error('Salon inaccessible ou plein');
  }

  disconnect(actor);
  actor.channelId = channelId;

  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,

    // Indispensable pour plusieurs bots dans un même programme.
    group: actor.client.user.id,

    selfMute: true,
    selfDeaf: true,
  });

  actor.connection = connection;

  connection.on('error', error =>
    logError(`Vocal bot ${actor.index + 1}`, error)
  );

  connection.on('stateChange', (_, state) => {
    if (actor.connection !== connection) return;

    if (state.status === V.Ready) {
      clearTimeout(actor.timer);
      actor.timer = null;
    } else if (
      state.status === V.Disconnected &&
      !actor.timer
    ) {
      actor.timer = setTimeout(() => disconnect(actor), 20000);
    } else if (state.status === V.Destroyed) {
      disconnect(actor);
    }
  });

  try {
    await entersState(connection, V.Ready, 20000);

    if (
      actor.connection !== connection ||
      me.voice.channelId !== channelId
    ) {
      throw new Error('Connexion interrompue');
    }

    if (channel.type === ChannelType.GuildStageVoice) {
      await me.voice.setSuppressed(true);
    }
  } catch (error) {
    disconnect(actor);
    throw error;
  }
}

for (const actor of actors) {
  actor.client.on(Events.Error, error =>
    logError(`Discord bot ${actor.index + 1}`, error)
  );

  actor.client.on(Events.VoiceStateUpdate, (before, after) => {
    if (
      !actor.connection ||
      after.id !== actor.client.user?.id ||
      after.guild.id !== guildId
    ) {
      return;
    }

    if (
      before.channelId === actor.channelId &&
      after.channelId !== actor.channelId
    ) {
      // Respecter une exclusion ou un déplacement par un modérateur.
      disconnect(actor);
    } else if (
      after.channel?.type === ChannelType.GuildStageVoice &&
      after.suppress === false
    ) {
      void after.setSuppressed(true).catch(error => {
        logError('Retour en auditeur', error);
        disconnect(actor);
      });
    }
  });
}

controller.on(Events.InteractionCreate, async interaction => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== 'netcord-live'
  ) {
    return;
  }

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (
      interaction.guildId !== guildId ||
      !allowed.has(interaction.user.id)
    ) {
      await interaction.editReply(
        'Cette commande est réservée aux utilisateurs autorisés par Netcord.'
      );
      return;
    }

    if (!ready || stopping || busy) {
      await interaction.editReply(
        'Démarrage ou opération en cours. Réessaie dans quelques instants.'
      );
      return;
    }

    busy = true;

    try {
      if (interaction.options.getSubcommand() === 'quitter') {
        actors.forEach(disconnect);

        await interaction.editReply(
          'Tous les bots sont déconnectés du live.'
        );
        return;
      }

      const channelId =
        interaction.options.getChannel('salon', true).id;

      if (actors.some(a => a.connection)) {
        await interaction.editReply(
          'Utilise /netcord-live quitter avant de rejoindre un autre live.'
        );
        return;
      }

      const failures = [];

      // Connecter les bots par petits lots.
      for (let i = 0; i < actors.length; i += 3) {
        const batch = actors.slice(i, i + 3);

        const results = await Promise.allSettled(
          batch.map(a => join(a, channelId))
        );

        results.forEach((result, n) => {
          if (result.status === 'rejected') {
            failures.push(batch[n].index + 1);
            logError(
              `Connexion bot ${batch[n].index + 1}`,
              result.reason
            );
          }
        });

        if (i + 3 < actors.length) await delay(1000);
      }

      const count = actors.filter(
        a => a.connection?.state.status === V.Ready
      ).length;

      await interaction.editReply(
        `${count}/${actors.length} bots connectés, muets et sourds.` +
        (
          failures.length
            ? ` Échec des bots : ${failures.join(', ')}. Vérifie leurs permissions et la capacité du salon.`
            : ''
        )
      );
    } finally {
      busy = false;
    }
  } catch (error) {
    logError('Commande', error);

    await interaction.editReply(
      'Erreur. Consulte les logs Railway.'
    ).catch(() => {});
  }
});

async function start() {
  for (const actor of actors) {
    const connected = new Promise(resolve =>
      actor.client.once(Events.ClientReady, resolve)
    );

    await actor.client.login(actor.token);
    await connected;

    if (stopping) return;

    const guild = actor.client.guilds.cache.get(guildId);

    if (!guild) {
      throw new Error(
        `Bot ${actor.index + 1} absent du serveur`
      );
    }

    console.log(
      `Bot ${actor.index + 1} connecté : ${actor.client.user.tag}`
    );

    // Supprimer les anciennes commandes du bot de présence.
    const names = new Set([
      'live-rejoindre',
      'live-quitter',
      'netcord-live',
    ]);

    for (const manager of [
      guild.commands,
      actor.client.application.commands,
    ]) {
      const existing = await manager.fetch();

      for (const old of existing.values()) {
        const keepControllerCommand =
          actor.index === 0 &&
          manager === guild.commands &&
          old.name === 'netcord-live';

        if (names.has(old.name) && !keepControllerCommand) {
          await manager.delete(old.id);
        }
      }
    }

    await delay(1000);
  }

  await controller.guilds.cache
    .get(guildId)
    .commands.create(command.toJSON());

  ready = true;

  console.log(
    `Netcord prêt : ${actors.length} bots, une seule commande.`
  );
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;

  actors.forEach(actor => {
    disconnect(actor);
    actor.client.destroy();
  });

  process.exit(code);
}

process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());

process.once('uncaughtException', error => {
  logError('Erreur fatale', error);
  shutdown(1);
});

process.once('unhandledRejection', error => {
  logError('Erreur fatale', error);
  shutdown(1);
});

start().catch(error => {
  logError('Démarrage', error);
  shutdown(1);
});
