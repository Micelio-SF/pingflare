<script lang="ts">
	import type { Snippet } from 'svelte';
	import { PUBLIC_STATUS_TITLE } from '$lib/config/brand';
	import MicelioLogo from '$lib/components/MicelioLogo.svelte';

	interface Props {
		title?: string;
		children: Snippet;
	}

	let { title = PUBLIC_STATUS_TITLE, children }: Props = $props();
</script>

<div class="min-h-screen bg-gray-50">
	<!-- Header -->
	<header class="border-b border-gray-200 bg-white">
		<div class="mx-auto max-w-4xl px-4 py-4 sm:px-6">
			<div class="flex items-center justify-between">
				<a href="/" class="flex items-center gap-2">
					<MicelioLogo class="h-8 w-8" />
					<span class="text-xl font-bold text-[#1E3A5F]">{title}</span>
				</a>
				<a href="/login" class="text-sm text-gray-600 hover:text-gray-900">Sign in</a>
			</div>
		</div>
	</header>

	<!-- Main Content -->
	<main class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
		{@render children()}
	</main>

	<!-- Footer -->
	<footer class="border-t border-gray-200 bg-white py-6">
		<div class="mx-auto max-w-4xl px-4 text-center text-sm text-gray-500 sm:px-6">
			A Micelio service
		</div>
	</footer>
</div>
