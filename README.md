# Bassm8s Photobooth

A photobooth application using Sony Camera API with Nuxt.js.

## Setup

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

### Telegram Integration

To enable sending photos to Telegram:

1. Create a Telegram bot by messaging [@BotFather](https://t.me/botfather) on Telegram and follow the instructions
2. Get your bot token from BotFather
3. Create a channel or group and add your bot to it
4. Get the chat ID of your channel or group
5. Set environment variables:

```bash
# In development, you can create a .env file in the root directory with:
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## API Endpoints

### Capture Photo
```
GET /api/capture
```
Captures a photo using the connected Sony camera and returns the image as base64 data.

### Stream Camera
```
GET /api/stream
```
Streams the camera viewfinder.

### Send to Telegram
```
POST /api/telegram
```
Sends a photo to a Telegram channel or group.

Request Body:
```json
{
  "image": "base64_encoded_image", // Optional: if not provided, captures a new photo
  "token": "your_bot_token", // Optional: if not provided, uses environment variable
  "chatId": "your_chat_id", // Optional: if not provided, uses environment variable
  "caption": "Photo caption" // Optional: defaults to "Photobooth image"
}
```

Response:
```json
{
  "success": true,
  "messageId": 123
}
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
