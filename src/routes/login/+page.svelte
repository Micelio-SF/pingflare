<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Container } from '$lib/components/layout';
	import { Card, Input, Button, Alert } from '$lib/components/ui';
	import MicelioLogo from '$lib/components/MicelioLogo.svelte';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let isSubmitting = $state(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';

		if (!email || !password) {
			error = 'Email and password are required';
			return;
		}

		isSubmitting = true;

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password })
			});

			const data = (await response.json()) as { error?: string };

			if (!response.ok) {
				error = data.error || 'Login failed';
				return;
			}

			await goto(resolve('/'));
		} catch {
			error = 'An error occurred. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Login - Micelio Status</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
	<Container size="sm">
		<div class="text-center">
			<MicelioLogo class="mx-auto h-12 w-12" />
			<h1 class="mt-4 text-2xl font-bold text-[#1E3A5F]">Micelio Status</h1>
			<p class="mt-1 text-gray-600">Sign in to your account</p>
		</div>

		<Card class="mt-8" padding="lg">
			{#if error}
				<div class="mb-4">
					<Alert variant="error">{error}</Alert>
				</div>
			{/if}

			<form onsubmit={handleSubmit} class="space-y-4">
				<Input
					type="email"
					name="email"
					label="Email"
					placeholder="you@example.com"
					bind:value={email}
					required
				/>

				<Input
					type="password"
					name="password"
					label="Password"
					placeholder="Enter your password"
					bind:value={password}
					required
				/>

				<Button type="submit" loading={isSubmitting} class="w-full">
					{isSubmitting ? 'Signing in...' : 'Sign in'}
				</Button>
			</form>
		</Card>
	</Container>
</div>
