<script>
  /** @type {'landing' | 'app'} */
  let { page = 'app' } = $props();

  let text = $state('');
  let status = $state('idle'); // 'idle' | 'submitting' | 'success' | 'error'
  let errorMsg = $state('');
  let expanded = $state(false);

  const MAX = 2000;
  let remaining = $derived(MAX - text.length);

  async function submit() {
    if (!text.trim() || status === 'submitting') return;
    status = 'submitting';
    errorMsg = '';
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), page }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      status = 'success';
      text = '';
      // Let the thanks message read, then drop the modal on its own.
      setTimeout(() => { if (status === 'success') reset(); }, 1800);
    } catch (err) {
      status = 'error';
      errorMsg = err.message || 'Something went wrong.';
    }
  }

  function reset() {
    status = 'idle';
    errorMsg = '';
    expanded = false;
  }

  /** Moves the modal to <body> so it escapes the landing grid's stacking/overflow. */
  function portal(node) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  function autofocus(node) {
    node.focus();
  }
</script>

<div class="feedback-widget" class:in-app={page === 'app'}>
  <button class="feedback-toggle" onclick={() => (expanded = true)}>
    Give Feedback
  </button>
</div>

{#if expanded}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class="feedback-overlay"
    use:portal
    onclick={reset}
    role="dialog"
    aria-modal="true"
    aria-label="Share feedback"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="feedback-panel" onclick={(e) => e.stopPropagation()} role="document">
      <div class="feedback-header">
        <span>Share Feedback</span>
        <button class="feedback-close-btn" onclick={reset} aria-label="Close"></button>
      </div>

      {#if status === 'success'}
        <div class="feedback-success">Thanks for the feedback!</div>
      {:else}
        <textarea
          use:autofocus
          bind:value={text}
          placeholder="What's on your mind? Bug reports, feature ideas, anything goes. All feedback is anonymous."
          maxlength={MAX}
          rows="7"
          disabled={status === 'submitting'}
        ></textarea>
        <div class="feedback-footer">
          <span class="char-count" class:warn={remaining < 200}>{remaining}</span>
          <button
            class="feedback-submit"
            onclick={submit}
            disabled={!text.trim() || status === 'submitting'}
          >
            {status === 'submitting' ? 'Sending...' : 'Send'}
          </button>
        </div>
        {#if status === 'error'}
          <div class="feedback-error">{errorMsg}</div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (expanded && e.key === 'Escape') reset(); }} />

<style>
  .feedback-widget {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 1000;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
  }

  .feedback-widget.in-app {
    position: static;
    width: 100%;
    margin-top: 0;
  }

  .feedback-toggle {
    background: rgba(0, 212, 170, 0.12);
    color: #00d4aa;
    border: 1px solid rgba(0, 212, 170, 0.3);
    padding: 0.6rem 1.2rem;
    border-radius: 50px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .feedback-toggle:hover {
    background: rgba(0, 212, 170, 0.2);
    border-color: #00d4aa;
    transform: translateY(-1px);
  }

  .in-app .feedback-toggle {
    width: 100%;
    min-height: 46px;
    height: 46px;
    padding: 13px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* The form lives in a portaled modal so it never reflows the button grid it
     was mounted into. z-index clears #landingPage (1000) and the timebar
     modals (10010). */
  .feedback-overlay {
    position: fixed;
    inset: 0;
    z-index: 10020;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.55);
    font-family: 'Inter', sans-serif;
    animation: feedback-fade 0.15s ease-out;
  }

  .feedback-panel {
    background: #1a1a24;
    border: 1px solid rgba(0, 212, 170, 0.25);
    border-radius: 12px;
    padding: 1rem;
    width: min(380px, 100%);
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
    animation: feedback-rise 0.18s ease-out;
  }

  @keyframes feedback-fade {
    from { opacity: 0; }
  }

  @keyframes feedback-rise {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
  }

  .feedback-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    font-weight: 600;
    color: #fff;
    font-size: 14px;
  }

  .feedback-close-btn {
    background: transparent;
    border: none;
    color: #f0f2f5;
    cursor: pointer;
    font-size: 0;
    padding: 0;
    line-height: 1;
    transition: color 0.15s;
  }

  .feedback-close-btn:hover {
    color: #fff;
  }

  .feedback-close-btn::before {
    content: '\00d7';
    font-size: 1.75rem;
    line-height: 1;
  }

  textarea {
    width: 100%;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: #fff;
    padding: 0.6rem 0.75rem;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    min-height: 140px;
    transition: border-color 0.15s;
  }

  textarea::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  textarea:focus {
    outline: none;
    border-color: rgba(0, 212, 170, 0.4);
  }

  textarea:disabled {
    opacity: 0.5;
  }

  .feedback-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.5rem;
  }

  .char-count {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.25);
  }

  .char-count.warn {
    color: #ffaa00;
  }

  .feedback-submit {
    background: #00d4aa;
    color: #000;
    border: none;
    padding: 0.45rem 1.2rem;
    border-radius: 6px;
    font-weight: 600;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }

  .feedback-submit:hover:not(:disabled) {
    background: #00e8bb;
    transform: translateY(-1px);
  }

  .feedback-submit:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .feedback-error {
    margin-top: 0.5rem;
    color: #ff5555;
    font-size: 12px;
    padding: 0.4rem 0.6rem;
    background: rgba(255, 85, 85, 0.08);
    border-radius: 6px;
  }

  .feedback-success {
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 212, 170, 0.12);
    border: 1px solid rgba(0, 212, 170, 0.3);
    color: #00d4aa;
    padding: 0.9rem 1rem;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
  }
</style>
