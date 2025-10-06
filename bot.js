import http from 'node:http';

// Start HTTP server immediately - this is all Render needs
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord bot is running');
});

server.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});

// Keep the process alive
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

// Start Discord bot after HTTP server is running
setTimeout(async () => {
  try {
    const { Client, Collection, GatewayIntentBits, Partials, Events } = await import('discord.js');
    
    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
      partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.Reaction, Partials.User]
    });

    client.once(Events.ClientReady, (c) => {
      console.log(`Logged in as ${c.user.tag}`);
    });

    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Discord bot failed to start:', error);
  }
}, 1000);
