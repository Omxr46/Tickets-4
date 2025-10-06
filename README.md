# Discord Ticket Bot

A simple Discord ticket bot with easy-to-use commands.

## Setup on Replit

1. **Import this project to Replit**
2. **Add environment variables in Replit:**
   - Go to the "Secrets" tab (lock icon)
   - Add these secrets:
     - `DISCORD_TOKEN` - Your bot token from Discord Developer Portal
     - `DISCORD_CLIENT_ID` - Your application ID
     - `DEV_GUILD_ID` - Your server ID (optional, for faster command deployment)

3. **Deploy commands:**
   - Click "Run" button
   - The bot will start and deploy slash commands

4. **Enable Always On:**
   - In Replit, click the "Always On" button (if available on your plan)
   - This keeps the bot running 24/7

## Commands

- `/overview` - Show all available commands
- `/category` - Create a ticket category
- `/channel` - Create a ticket channel with open button
- `/stats` - View ticket statistics

## How to Use

1. Run `/category name:Tickets` to create a category
2. Run `/channel name:open-ticket` to create a channel with ticket button
3. Users click the button to open tickets
4. Staff can manage tickets with the buttons in each ticket channel

