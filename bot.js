import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, Partials, REST, Routes, Events, PermissionFlagsBits } from 'discord.js';
import { ensureDatabase } from './db.js';
import fs from 'node:fs';
import path from 'node:path';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User]
});

client.commands = new Collection();

// Dynamically load commands from the correct folder
const commandsPath = path.join(process.cwd(), 'commands');
if (fs.existsSync(commandsPath)) {
  const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = (await import(pathToFileURL(filePath).href)).default;
    if (command?.data?.name) {
      client.commands.set(command.data.name, command);
    }
  }
}

// Fallback safe import for pathToFileURL without top import noise
function pathToFileURL(p) {
  const url = new URL('file://');
  const pathname = path.resolve(p).replace(/\\/g, '/');
  url.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return url;
}

ensureDatabase();

// Basic env preflight to surface common token misconfigurations early
function validateEnvOrExit() {
  const token = process.env.DISCORD_TOKEN || '';
  const appId = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '';
  if (!token) {
    console.error('Missing DISCORD_TOKEN in environment.');
    process.exit(1);
  }
  // Discord bot tokens are three dot-separated parts. This won't validate authenticity, just shape.
  const looksLikeToken = token.split('.').length === 3 && !token.startsWith('Bot ');
  if (!looksLikeToken) {
    console.error('DISCORD_TOKEN does not look like a valid bot token. Ensure you pasted the Bot Token (three dot-separated parts), without quotes or "Bot ".');
    process.exit(1);
  }
  if (!appId) {
    console.error('Missing DISCORD_CLIENT_ID (Application ID) in environment.');
  }
}

validateEnvOrExit();

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startAutoArchiveSweep();
  try { c.user.setPresence({ activities: [{ name: 'Light Services tickets', type: 3 }], status: 'online' }); } catch {}
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const [scope, action, arg] = interaction.customId.split(':');
      if (scope !== 'ticket') return;
      const handler = buttonHandlers[action];
      if (!handler) return;
      await handler(interaction, arg);
      return;
    }

    if (interaction.isModalSubmit()) {
      const [scope, action, arg] = interaction.customId.split(':');
      if (scope !== 'ticket') return;
      const handler = modalHandlers[action];
      if (!handler) return;
      await handler(interaction, arg);
      return;
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.isRepliable()) {
      const content = 'Something went wrong. Please try again or contact staff.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    }
  }
});

// Ticket helpers
import { getGuildConfig, ensureTicket, getTicketByChannelId, updateTicketStatus, addUserToTicket, removeUserFromTicket, claimTicket, unclaimTicket, countOpenTicketsForUser, getLastTicketCreatedAt, getClosedTicketsOlderThan, markTicketArchived, getPanelById, countOpenTicketsForUserInPanel, getLastTicketCreatedAtInPanel, setTicketCloseReason } from './db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField } from 'discord.js';

async function createTicketChannel(interaction, reason, panel = null) {
  const guild = interaction.guild;
  const member = interaction.member;
  const config = getGuildConfig(guild.id);
  let ticketsCategoryId = config?.tickets_category_id || config?.ticketsCategoryId;
  let staffRoleId = config?.staff_role_id || config?.staffRoleId;
  
  // Auto-create missing components
  if (!staffRoleId) {
    const staffRole = await guild.roles.create({
      name: 'Staff',
      color: 0x2b2d31,
      reason: 'Auto-created for ticket system'
    });
    staffRoleId = staffRole.id;
  }
  
  if (!ticketsCategoryId) {
    const ticketsCategory = await guild.channels.create({
      name: 'Tickets',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
      ],
      reason: 'Auto-created for ticket system'
    });
    ticketsCategoryId = ticketsCategory.id;
  } else {
    // Verify the category still exists
    const existingCategory = guild.channels.cache.get(ticketsCategoryId);
    if (!existingCategory || existingCategory.type !== ChannelType.GuildCategory) {
      // Category was deleted, create a new one
      const ticketsCategory = await guild.channels.create({
        name: 'Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel] }
        ],
        reason: 'Re-created deleted ticket category'
      });
      ticketsCategoryId = ticketsCategory.id;
    }
  }
  
  // Save config if it was auto-created or recreated
  if (!config || !config.tickets_category_id || !config.staff_role_id || config.tickets_category_id !== ticketsCategoryId) {
    const { upsertGuildConfig } = await import('./db.js');
    upsertGuildConfig(guild.id, staffRoleId, ticketsCategoryId);
  }

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
  ];

  const channelName = `ticket-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: ticketsCategoryId,
    permissionOverwrites: overwrites,
    reason: `Ticket for ${member.user.tag}: ${reason}`
  });

  const ticket = ensureTicket(guild.id, channel.id, member.id, reason, panel?.id ?? null);

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket:adduser:${ticket.id}`).setLabel('Add User').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:removeuser:${ticket.id}`).setLabel('Remove User').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:transcript:${ticket.id}`).setLabel('Transcript').setStyle(ButtonStyle.Secondary)
  );

  const embed = createBrandEmbed('Ticket Created', `Thanks for opening a ticket. A staff member will be with you shortly.\n\nReason: ${reason}`);
  await channel.send({ content: `<@${member.id}>`, embeds: [embed], components: [controls] });
  // Auto-rename with ticket id and priority
  try {
    await channel.setName(`ticket-${ticket.id}-${(ticket.priority || 'normal').slice(0,6)}`);
  } catch {}
  return channel;
}

function isStaffOrAdmin(member, guildId) {
  const config = getGuildConfig(guildId) || {};
  const staffRoleId = config.staff_role_id || config.staffRoleId;
  const isAdmin = member.permissions?.has?.(PermissionsBitField.Flags.Administrator);
  const isStaff = staffRoleId ? member.roles?.cache?.has?.(staffRoleId) : false;
  return Boolean(isAdmin || isStaff);
}

function buildControls(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket:adduser:${ticketId}`).setLabel('Add User').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:removeuser:${ticketId}`).setLabel('Remove User').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:transcript:${ticketId}`).setLabel('Transcript').setStyle(ButtonStyle.Secondary)
  );
}

function buildReopenRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:reopen:${ticketId}`).setLabel('Reopen').setStyle(ButtonStyle.Success)
  );
}

const buttonHandlers = {
  async open(interaction) {
    const modal = new ModalBuilder().setCustomId('ticket:open').setTitle('Open a Ticket');
    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Briefly describe your issue')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
  },
  async openpanel(interaction, panelId) {
    // open using a specific panel, carrying panelId via modal
    const modal = new ModalBuilder().setCustomId(`ticket:openpanel:${panelId}`).setTitle('Open a Ticket');
    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Briefly describe your issue')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
  },
  async close(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    // Ask for a close reason via modal
    const modal = new ModalBuilder().setCustomId(`ticket:closereason:${ticket.id}`).setTitle('Close Ticket');
    const reasonInput = new TextInputBuilder().setCustomId('close_reason').setLabel('Close reason').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
    try { await interaction.channel.permissionOverwrites.edit(ticket.userId, { ViewChannel: false }); } catch {}
  },
  async reopen(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    await updateTicketStatus(ticket.id, 'open');
    await interaction.reply({ content: 'Ticket reopened by ' + interaction.user.tag, components: [buildControls(ticket.id)] });
    try { await interaction.channel.permissionOverwrites.edit(ticket.userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }); } catch {}
  },
  async claim(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    await claimTicket(ticket.id, interaction.user.id);
    await interaction.reply({ content: `Ticket claimed by <@${interaction.user.id}>` });
  },
  async unclaim(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    await unclaimTicket(ticket.id);
    await interaction.reply({ content: `Ticket unclaimed by <@${interaction.user.id}>` });
  },
  async adduser(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId('ticket:adduser').setTitle('Add User to Ticket');
    const input = new TextInputBuilder().setCustomId('user_id').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  },
  async removeuser(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    const modal = new ModalBuilder().setCustomId('ticket:removeuser').setTitle('Remove User from Ticket');
    const input = new TextInputBuilder().setCustomId('user_id').setLabel('User ID').setStyle(TextInputStyle.Short).setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  },
  async transcript(interaction, ticketId) {
    if (!isStaffOrAdmin(interaction.member, interaction.guildId)) {
      return interaction.reply({ content: 'You do not have permission to do that.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const channel = interaction.channel;
    try {
      const mod = await import('./utils/transcript.js');
      const filePath = await mod.generateTranscript(channel);
      await interaction.followUp({ content: 'Transcript generated.', files: [filePath], ephemeral: true });
    } catch (err) {
      console.error('Transcript module load error:', err);
      await interaction.followUp({ content: 'Transcript feature is temporarily unavailable.', ephemeral: true });
    }
  }
};

const modalHandlers = {
  async open(interaction) {
    const reason = interaction.fields.getTextInputValue('reason');
    // Limits and cooldowns
    const config = getGuildConfig(interaction.guildId) || {};
    const maxOpen = config.max_open_tickets ?? config.maxOpenTickets ?? null;
    const cooldownSec = config.open_cooldown_sec ?? config.openCooldownSec ?? null;
    if (maxOpen) {
      const currentOpen = countOpenTicketsForUser(interaction.guildId, interaction.user.id);
      if (currentOpen >= maxOpen) {
        await interaction.reply({ content: `You have reached the maximum of ${maxOpen} open ticket(s). Please close one before opening another.`, ephemeral: true });
        return;
      }
    }
    if (cooldownSec) {
      const lastCreated = getLastTicketCreatedAt(interaction.guildId, interaction.user.id);
      if (lastCreated) {
        const now = Math.floor(Date.now() / 1000);
        const remaining = (lastCreated + cooldownSec) - now;
        if (remaining > 0) {
          await interaction.reply({ content: `Please wait ${Math.ceil(remaining)}s before opening another ticket.`, ephemeral: true });
          return;
        }
      }
    }
    const channel = await createTicketChannel(interaction, reason);
    if (channel) {
      await interaction.reply({ content: `Ticket created: <#${channel.id}>`, ephemeral: true });
    }
  },
  async closereason(interaction, ticketId) {
    const reason = interaction.fields.getTextInputValue('close_reason') || 'No reason provided';
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    setTicketCloseReason(ticket.id, reason);
    await updateTicketStatus(ticket.id, 'closed');
		await interaction.reply({ content: `Ticket closed by ${interaction.user.tag}. Reason: ${reason}`, components: [buildReopenRow(ticket.id)] });
		// If an admin/staff closed the ticket, delete the channel after 5 seconds
		try {
			if (isStaffOrAdmin(interaction.member, interaction.guildId)) {
				setTimeout(async () => {
					try { await interaction.channel.delete('Auto-delete 5s after close by staff'); } catch {}
				}, 5000);
			}
		} catch {}
  },
  async openpanel(interaction) {
    const reason = interaction.fields.getTextInputValue('reason');
    const parts = interaction.customId.split(':');
    const panelId = parts[2];
    const panel = getPanelById(Number(panelId));
    if (!panel || panel.guild_id !== interaction.guildId) {
      await interaction.reply({ content: 'Panel not found.', ephemeral: true });
      return;
    }
    // Per-panel limits/cooldowns
    if (panel.max_open_tickets) {
      const currentOpen = countOpenTicketsForUserInPanel(interaction.guildId, interaction.user.id, panel.id);
      if (currentOpen >= panel.max_open_tickets) {
        await interaction.reply({ content: `You have reached the maximum of ${panel.max_open_tickets} open ticket(s) for this panel.`, ephemeral: true });
        return;
      }
    }
    if (panel.open_cooldown_sec) {
      const last = getLastTicketCreatedAtInPanel(interaction.guildId, interaction.user.id, panel.id);
      if (last) {
        const now = Math.floor(Date.now() / 1000);
        const remaining = (last + panel.open_cooldown_sec) - now;
        if (remaining > 0) {
          await interaction.reply({ content: `Please wait ${Math.ceil(remaining)}s before opening another ticket in this panel.`, ephemeral: true });
          return;
        }
      }
    }
    // temporarily override category for creation
    const originalGetGuildConfig = getGuildConfig;
    const wrappedGetGuildConfig = (guildId) => {
      const cfg = originalGetGuildConfig(guildId) || {};
      return { ...cfg, tickets_category_id: panel.category_id };
    };
    // create channel using overridden category
    const channel = await (async () => {
      const guild = interaction.guild;
      const member = interaction.member;
      const ticketsCategoryId = panel.category_id;
      const staffRoleId = (getGuildConfig(guild.id)?.staff_role_id) || (getGuildConfig(guild.id)?.staffRoleId);
      if (!ticketsCategoryId || !staffRoleId) {
        await interaction.reply({ content: 'Ticket system is not configured. Ask an admin to run /setup.', ephemeral: true });
        return null;
      }
      const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: staffRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }
      ];
      const channelName = `ticket-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const ch = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: ticketsCategoryId,
        permissionOverwrites: overwrites,
        reason: `Ticket for ${member.user.tag}: ${reason}`
      });
      const ticket = ensureTicket(guild.id, ch.id, member.id, reason, panel.id);
      const controls = buildControls(ticket.id);
      const embed = createBrandEmbed('Ticket Created', `Thanks for opening a ticket. A staff member will be with you shortly.\n\nReason: ${reason}`);
      await ch.send({ content: `<@${member.id}>`, embeds: [embed], components: [controls] });
      try { await ch.setName(`ticket-${ticket.id}-${(ticket.priority || 'normal').slice(0,6)}`); } catch {}
      return ch;
    })();
    if (channel) {
      await interaction.reply({ content: `Ticket created: <#${channel.id}>`, ephemeral: true });
    }
  },
  async adduser(interaction) {
    const userId = interaction.fields.getTextInputValue('user_id');
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    try {
      await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      addUserToTicket(ticket.id, userId);
      await interaction.reply({ content: `Added <@${userId}> to the ticket.` });
    } catch (e) {
      await interaction.reply({ content: 'Failed to add user. Ensure the ID is correct.', ephemeral: true });
    }
  },
  async removeuser(interaction) {
    const userId = interaction.fields.getTextInputValue('user_id');
    const ticket = getTicketByChannelId(interaction.channelId);
    if (!ticket) return interaction.reply({ content: 'Not a ticket channel.', ephemeral: true });
    try {
      await interaction.channel.permissionOverwrites.delete(userId);
      removeUserFromTicket(ticket.id, userId);
      await interaction.reply({ content: `Removed <@${userId}> from the ticket.` });
    } catch (e) {
      await interaction.reply({ content: 'Failed to remove user. Ensure the ID is correct.', ephemeral: true });
    }
  }
};

await client.login(process.env.DISCORD_TOKEN);

function startAutoArchiveSweep() {
  const intervalMs = 5 * 60 * 1000; // every 5 minutes
  setInterval(async () => {
    try {
      for (const [guildId, guild] of client.guilds.cache) {
        const config = getGuildConfig(guildId);
        const hours = config?.auto_archive_hours ?? config?.autoArchiveHours;
        if (!hours || hours <= 0) continue;
        const cutoff = Math.floor(Date.now() / 1000) - (hours * 3600);
        const candidates = getClosedTicketsOlderThan(guildId, cutoff);
        for (const ticket of candidates) {
          try {
            const channel = await guild.channels.fetch(ticket.channel_id).catch(() => null);
            if (channel) await channel.delete('Auto-archive of closed ticket');
          } catch {}
          markTicketArchived(ticket.id);
        }
      }
    } catch (err) {
      console.error('Auto-archive sweep error:', err);
    }
  }, intervalMs);
}


