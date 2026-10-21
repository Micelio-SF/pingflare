/**
 * Custom Cloudflare Worker entry point that wraps SvelteKit's generated handler
 * and adds a scheduled handler for cron-triggered health checks.
 *
 * This enables deployment via Cloudflare Workers (with Deploy Button support)
 * instead of Cloudflare Pages.
 */

// The SvelteKit handler is imported at build time from the generated output
// @ts-expect-error - This import is resolved during the build process
import svelteKitHandler from './__sveltekit/handler.js';
import { maintenanceScheduled as scheduled } from './lib/server/scheduler';

interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ENVIRONMENT?: string;
	CRON_SECRET?: string;
}

export default {
	/**
	 * Handle incoming HTTP requests by delegating to SvelteKit's generated handler.
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return svelteKitHandler.fetch(request, env, ctx);
	},

	scheduled
};
