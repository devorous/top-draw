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
</script>

<div class="feedback-widget" class:in-app={page === 'app'}>
  {#if !expanded && status !== 'success'}
    <button class="feedback-toggle" onclick={() => (expanded = true)}>
      💬 Give Feedback
    </button>
  {:else if status === 'success'}
    <div class="feedback-success">
      <span>Thanks for the feedback!</span>
      <button class="feedback-close-btn" onclick={reset}>✕</button>
    </div>
  {:else}
    <div class="feedback-panel">
      <div class="feedback-header">
        <span>Share Feedback</span>
        <button class="feedback-close-btn" onclick={reset}>✕</button>
      </div>
      <textarea
        bind:value={text}
        placeholder="What's on your mind? Bug reports, feature ideas, anything goes. All feedback is anonymous."
        maxlength={MAX}
        rows="4"
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
    </div>
  {/if}
</div>

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
    font-size: 12px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .feedback-panel {
    background: #1a1a24;
    border: 1px solid rgba(0, 212, 170, 0.25);
    border-radius: 12px;
    padding: 1rem;
    width: 320px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .in-app .feedback-panel {
    width: 100%;
    box-shadow: none;
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.08);
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
    min-height: 80px;
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
    gap: 0.75rem;
    background: rgba(0, 212, 170, 0.12);
    border: 1px solid rgba(0, 212, 170, 0.3);
    color: #00d4aa;
    padding: 0.6rem 1rem;
    border-radius: 50px;
    font-size: 13px;
    font-weight: 600;
  }

  .in-app .feedback-success {
    border-radius: 8px;
    justify-content: center;
  }
</style>
