<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    task: string;
    image?: string;
    audio?: string;
    video?: string;
    error?: string;
    input?: string;
  }

  let { task, image, audio, video, error: initError, input }: Props = $props();

  let status = $state<'done' | 'error'>('done');
  let errorMsg = $state('');

  onMount(() => {
    if (initError) {
      errorMsg = initError;
      status = 'error';
    }
  });
</script>

<div class="model-output">
  {#if status === 'error'}
    <div class="model-output-error">{errorMsg}</div>
  {:else if image}
    <img src={image} alt={input ?? 'Generated image'} class="model-output-image" />
  {:else if video}
    <div class="model-output-video">
      <div class="video-header">
        <i class="fas fa-film"></i>
        <span>Generated Video</span>
      </div>
      {#if video.endsWith('.mp4')}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video controls src={video} preload="auto" class="video-player" loop>
          <track kind="captions" />
        </video>
      {:else if video.endsWith('.gif')}
        <img src={video} alt={input ?? 'Generated video'} class="model-output-image" />
      {:else}
        <div class="video-frames-note">
          <i class="fas fa-folder-open"></i>
          <span>Frames saved to: {video}</span>
        </div>
      {/if}
      <div class="video-actions">
        <a href={video} download class="video-download" title="Download video">
          <i class="fas fa-download"></i> Download
        </a>
      </div>
    </div>
  {:else if audio}
    <div class="model-output-audio">
      <div class="audio-header">
        <i class="fas fa-microphone"></i>
        <span>Generated Audio</span>
      </div>
      <audio controls src={audio} preload="auto" class="audio-player"></audio>
      <div class="audio-actions">
        <a href={audio} download class="audio-download" title="Download audio">
          <i class="fas fa-download"></i> Download WAV
        </a>
      </div>
    </div>
  {/if}
</div>

<style>
  .model-output {
    margin: 0.5rem 0;
  }
  .model-output-error {
    color: var(--red, #ef4444);
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }
  .model-output-image {
    max-width: 100%;
    border-radius: 8px;
    margin: 0.25rem 0;
  }
  .model-output-audio {
    background: var(--surface, #1e1e2e);
    border: 1px solid var(--border, #333);
    border-radius: 10px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 400px;
  }
  .audio-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted, #888);
  }
  .audio-header i {
    color: var(--green, #22c55e);
  }
  .audio-player {
    width: 100%;
    height: 36px;
    border-radius: 6px;
  }
  .audio-actions {
    display: flex;
    justify-content: flex-end;
  }
  .audio-download {
    font-size: 0.75rem;
    color: var(--text-muted, #888);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: color 0.15s;
  }
  .audio-download:hover {
    color: var(--green, #22c55e);
  }
  .model-output-video {
    background: var(--surface, #1e1e2e);
    border: 1px solid var(--border, #333);
    border-radius: 10px;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 540px;
  }
  .video-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted, #888);
  }
  .video-header i {
    color: var(--purple, #a78bfa);
  }
  .video-player {
    width: 100%;
    border-radius: 8px;
    max-height: 400px;
  }
  .video-frames-note {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted, #888);
    padding: 0.5rem 0;
  }
  .video-frames-note i {
    color: var(--amber, #fbbf24);
  }
  .video-actions {
    display: flex;
    justify-content: flex-end;
  }
  .video-download {
    font-size: 0.75rem;
    color: var(--text-muted, #888);
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: color 0.15s;
  }
  .video-download:hover {
    color: var(--purple, #a78bfa);
  }
</style>
