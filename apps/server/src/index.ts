import { createServer } from "./app.js";
import { readRuntimeConfig } from "@videocut/project-overview";

const runtimeConfig = readRuntimeConfig();
const { port, host, serveWeb } = runtimeConfig.http;

const { app } = await createServer({ serveWeb });
await app.listen({ port, host });
