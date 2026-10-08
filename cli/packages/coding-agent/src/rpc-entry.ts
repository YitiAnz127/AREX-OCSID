#!/usr/bin/env node
import { isolateOCSIDProcessFromPiEnvironment } from "./cli/pi-environment-isolation.ts";

process.env.OCSID_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;
isolateOCSIDProcessFromPiEnvironment();

const [{ APP_NAME }, { configureHttpDispatcher }, { main }] = await Promise.all([
	import("./config.ts"),
	import("./core/http-dispatcher.ts"),
	import("./main.ts"),
]);

process.title = `${APP_NAME}-rpc`;

configureHttpDispatcher();

await main(["--mode", "rpc", ...process.argv.slice(2)]);
