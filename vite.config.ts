import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		SvelteKitPWA({
			srcDir: 'src',
			strategies: 'generateSW',
			registerType: 'autoUpdate',
			kit: {
				includeVersionFile: true
			},
			manifest: {
				name: 'Micelio Status',
				short_name: 'Micelio',
				description: 'Micelio service status and uptime monitoring',
				theme_color: '#1E3A5F',
				background_color: '#ffffff',
				display: 'standalone',
				scope: '/',
				start_url: '/',
				icons: [
					{
						src: '/icon.svg',
						sizes: 'any',
						type: 'image/svg+xml'
					},
					{
						src: '/icon-maskable.svg',
						sizes: 'any',
						type: 'image/svg+xml',
						purpose: 'maskable'
					}
				]
			},
			workbox: {
				globPatterns: ['client/**/*.{js,css,ico,png,svg,webp,webmanifest}'],
				navigateFallback: null,
				// Import push notification handler into the generated service worker
				importScripts: ['/sw-push.js'],
				runtimeCaching: [
					{
						urlPattern: /^https:\/\/.*\/_app\/.*/,
						handler: 'CacheFirst',
						options: {
							cacheName: 'app-assets',
							expiration: {
								maxEntries: 100,
								maxAgeSeconds: 60 * 60 * 24 * 30
							}
						}
					}
				]
			},
			devOptions: {
				enabled: false
			}
		})
	]
});
