import { registerAs } from '@nestjs/config';

export default registerAs('webhooks', () => ({
  svixApiKey: process.env.SVIX_API_KEY,
  svixServerUrl: process.env.SVIX_SERVER_URL,
}));
