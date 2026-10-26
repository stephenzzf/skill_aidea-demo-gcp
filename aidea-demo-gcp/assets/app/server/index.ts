import express from 'express';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const { spec, scenario, config } = await loadConfig();
const app = createApp(spec, scenario, config);
const dev = process.argv.includes('--dev');
if (dev) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, await readFile('index.html', 'utf8'))); }
    catch (error) { next(error); }
  });
} else {
  const client = resolve('dist/client');
  app.use(express.static(client, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(client, 'index.html')));
}
const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, process.env.HOST ?? (dev ? '127.0.0.1' : '0.0.0.0'), () => console.log(`ME Demo ${spec.id} (${config.mode}) ready on :${port}`));
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
