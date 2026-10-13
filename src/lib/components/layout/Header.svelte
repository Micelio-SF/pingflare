<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import type { UserPublic } from '$lib/types/auth';
	import MicelioLogo from '$lib/components/MicelioLogo.svelte';

	let { user = undefined }: { user?: UserPublic | null } = $props();

	let loggingOut = $state(false);

	async function handleLogout() {
		loggingOut = true;
		try {
			await fetch('/api/auth/logout', { method: 'POST' });
			await goto('/login');
		} finally {
			loggingOut = false;
		}
	}

	interface NavItem {
		href: string;
		label: string;
		match: (path: string) => boolean;
	}

	const navItems: NavItem[] = [
		{ href: '/dashboard', label: 'Dashboard', match: (path) => path === '/dashboard' },
		{
			href: '/admin/status',
			label: 'Status',
			match: (path) => path.startsWith('/admin/status') || path.startsWith('/announcements')
		},
		{
			href: '/notifications',
			label: 'Notifications',
			match: (path) => path.startsWith('/notifications')
		},
		{ href: '/settings', label: 'Settings', match: (path) => path.startsWith('/settings') }
	];

	const currentPath = $derived($page.url.pathname);
</script>

<header class="hidden border-b border-gray-200 bg-white md:block">
	<div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
		<div class="flex items-center gap-8">
			<a href="/dashboard" class="flex items-center gap-2">
				<MicelioLogo class="h-8 w-8" />
				<span class="text-lg font-semibold text-[#1E3A5F]">Micelio Status</span>
			</a>

			<nav class="flex items-center gap-1">
				{#each navItems as item (item.href)}
					{@const isActive = item.match(currentPath)}
					<a
						href={item.href}
						class="rounded-lg px-3 py-2 text-sm font-medium transition-colors {isActive
							? 'bg-gray-100 text-gray-900'
							: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}"
						aria-current={isActive ? 'page' : undefined}
					>
						{item.label}
					</a>
				{/each}
			</nav>
		</div>

		{#if user}
			<div class="flex items-center gap-4">
				<span class="text-sm text-gray-600">{user.name}</span>
				<button
					type="button"
					onclick={handleLogout}
					disabled={loggingOut}
					class="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50"
				>
					{loggingOut ? 'Logging out...' : 'Log out'}
				</button>
			</div>
		{/if}
	</div>
</header>
