'use strict';

const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits: P,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus: V,
} = require('@discordjs/voice');

// Variables Railway obligatoires.
for (const name of ['DISCORD_TOKEN', 'DISCORD_GUILD_ID']) {
  if (!process.env[name]?.trim()) {
    throw new Error(`Variable manquante: ${name}`);
  }
}

const guildId = process.env.DISCORD_GUILD_ID;

if (!/^\d{17,20}$/.test(guildId)) {
  throw new Error('DISCORD_GUILD_ID invalide.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let connection = null;
let selectedChannel = null;
let busy = false;
let ready = false;
let stopping = false;
let reconnectTimer = null;

class UserError extends Error {}

function logError(where, error) {
  // Ne jamais afficher d'objet pouvant contenir le token.
  console.error(
    `${where}: ${error?.code || error?.name || 'Erreur'}`
  );
}

function disconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const previous = connection;
  connection = null;
  selectedChannel = null;

  if (previous && previous.state.status !== V.Destroyed) {
    previous.destroy();
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('live-rejoindre')
    .setDescription('Rejoindre un live en restant muet')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addChannelOption(option =>
      option
        .setName('salon')
        .setDescription('Salon vocal ou Stage à rejoindre')
        .setRequired(true)
        .addChannelTypes(
          ChannelType.GuildVoice,
          ChannelType.GuildStageVoice
        )
    ),

  new SlashCommandBuilder()
    .setName('live-quitter')
    .setDescription('Quitter le live')
    .setDefaultMemberPermissions(P.ManageGuild),
];

client.on(Events.InteractionCreate, async interaction => {
  if (
    !interaction.isChatInputCommand() ||
    !commands.some(c => c.name === interaction.commandName)
  ) {
    return;
  }

  try {
    // Confirmation privée, jamais de message public.
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (
      interaction.guildId !== guildId ||
      !interaction.memberPermissions?.has(P.ManageGuild)
    ) {
      throw new UserError(
        'Commande réservée aux membres ayant « Gérer le serveur ».'
      );
    }

    if (!ready || stopping) {
      throw new UserError(
        'Le bot démarre ou s’arrête. Réessaie dans quelques instants.'
      );
    }

    if (busy) {
      throw new UserError('Une commande est déjà en cours.');
    }

    busy = true;

    try {
      if (interaction.commandName === 'live-quitter') {
        disconnect();
        await interaction.editReply('Déconnecté du live.');
        return;
      }

      if (connection) {
        throw new UserError(
          'Le bot est déjà connecté. Utilise /live-quitter avant de changer de salon.'
        );
      }

      const chosenChannel =
        interaction.options.getChannel('salon', true);

      const channel =
        await interaction.guild.channels.fetch(chosenChannel.id);

      if (
        ![
          ChannelType.GuildVoice,
          ChannelType.GuildStageVoice,
        ].includes(channel?.type)
      ) {
        throw new UserError(
          'Choisis un salon vocal ou Stage de ce serveur.'
        );
      }

      const me = await interaction.guild.members.fetchMe();

      if (
        !channel.permissionsFor(me)?.has([
          P.ViewChannel,
          P.Connect,
        ]) ||
        !channel.joinable
      ) {
        throw new UserError(
          'Salon inaccessible ou plein. Le bot doit pouvoir voir le salon et s’y connecter.'
        );
      }

      selectedChannel = channel.id;

      const current = joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator:
          interaction.guild.voiceAdapterCreator,

        // Bot muet et sourd : présence uniquement.
        selfMute: true,
        selfDeaf: true,
      });

      connection = current;

      current.on('error', error => {
        logError('Connexion vocale', error);
      });

      current.on('stateChange', (_, state) => {
        if (connection !== current) return;

        if (state.status === V.Ready) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        } else if (
          state.status === V.Disconnected &&
          !reconnectTimer
        ) {
          // Laisser la bibliothèque rétablir
          // une coupure transitoire.
          reconnectTimer = setTimeout(() => {
            if (connection === current) disconnect();
          }, 20000);
        } else if (state.status === V.Destroyed) {
          disconnect();
        }
      });

      try {
        await entersState(current, V.Ready, 30000);

        if (
          connection !== current ||
          me.voice.channelId !== channel.id
        ) {
          throw new UserError(
            'Connexion interrompue ou bot déplacé pendant la connexion.'
          );
        }

        // Sur un Stage, rester dans le public.
        if (channel.type === ChannelType.GuildStageVoice) {
          await me.voice.setSuppressed(true);
        }

        await interaction.editReply(
          'Connecté au live, muet. Aucun audio reçu ou enregistré.'
        );
      } catch (error) {
        disconnect();

        if (error instanceof UserError) throw error;

        logError('Connexion impossible', error);

        throw new UserError(
          'Connexion impossible. Vérifie les permissions et les logs Railway.'
        );
      }
    } finally {
      busy = false;
    }
  } catch (error) {
    logError('Commande', error);

    try {
      await interaction.editReply(
        error instanceof UserError
          ? error.message
          : 'Une erreur est survenue. Consulte les logs Railway.'
      );
    } catch {
      // Aucune réponse publique de secours.
    }
  }
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  if (
    !connection ||
    after.id !== client.user?.id ||
    after.guild.id !== guildId
  ) {
    return;
  }

  if (
    before.channelId === selectedChannel &&
    after.channelId !== selectedChannel
  ) {
    // Ne pas revenir après une exclusion ou un déplacement.
    disconnect();
  } else if (
    after.channel?.type === ChannelType.GuildStageVoice &&
    after.suppress === false
  ) {
    // Revenir dans le public si le bot est promu intervenant.
    void after.setSuppressed(true).catch(error => {
      logError('Retour en auditeur', error);
      disconnect();
    });
  }
});

client.on(Events.Error, error => {
  logError('Discord', error);
});

client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(guildId);

    // Enregistrer les commandes automatiquement.
    // Les éventuelles autres commandes sont conservées.
    for (const command of commands) {
      await guild.commands.create(command.toJSON());
    }

    ready = true;
    console.log(
      'Bot prêt : présence uniquement, muet et sourd.'
    );
  } catch (error) {
    logError('Démarrage', error);
    shutdown(1);
  }
});

function shutdown(code = 0) {
  if (stopping) return;

  stopping = true;
  disconnect();
  client.destroy();
  process.exit(code);
}

process.once('SIGTERM', () => shutdown());
process.once('SIGINT', () => shutdown());

process.once('uncaughtException', error => {
  logError('Erreur fatale', error);
  shutdown(1);
});

process.once('unhandledRejection', error => {
  logError('Promesse non traitée', error);
  shutdown(1);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  logError('Connexion Discord', error);
  shutdown(1);
});
