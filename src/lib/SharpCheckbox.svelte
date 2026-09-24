<!-- SharpCheckbox: 18px square, 1px --line border, --accent fill with a
     black check when checked (spec §7/Step 1.3). Native input keeps
     keyboard/focus behavior. I13: a visible label or an aria-label is
     mandatory — rendering without either throws. -->

<script lang="ts">
	let {
		checked = $bindable(false),
		label = '',
		ariaLabel = '',
		name = undefined,
		required = false,
		disabled = false,
		onchange = undefined
	}: {
		checked?: boolean;
		label?: string;
		ariaLabel?: string;
		name?: string;
		required?: boolean;
		disabled?: boolean;
		onchange?: (event: Event) => void;
	} = $props();

	const labelIsValid = $derived.by(() => {
		if (!label && !ariaLabel) {
			throw new Error('SharpCheckbox requires a visible label or an aria-label (I13)');
		}
		return true;
	});
</script>

{#if labelIsValid}
<label class="sharp-checkbox" class:disabled>
	<input
		type="checkbox"
		bind:checked
		{name}
		{required}
		{disabled}
		onchange={onchange}
		aria-label={ariaLabel || undefined}
	/>
	{#if label}<span class="label-text">{label}</span>{/if}
</label>
{/if}

<style>
	.sharp-checkbox {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
	}

	.sharp-checkbox.disabled {
		cursor: default;
		opacity: 0.4;
	}

	input[type='checkbox'] {
		appearance: none;
		flex: none;
		width: 18px;
		height: 18px;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		background: transparent;
		cursor: pointer;
	}

	input[type='checkbox']:checked {
		border-color: var(--accent);
		background: var(--accent)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 10'%3E%3Cpath d='M1 5l3.5 3.5L11 1' fill='none' stroke='%230a0a0c' stroke-width='2'/%3E%3C/svg%3E")
			center / 12px no-repeat;
	}

	input[type='checkbox']:disabled {
		cursor: default;
	}

	input[type='checkbox']:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: 2px;
	}

	.label-text {
		color: var(--text);
		font-size: 14px;
	}
</style>
