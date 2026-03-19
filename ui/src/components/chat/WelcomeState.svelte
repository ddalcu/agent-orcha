<script lang="ts">
  import SampleQuestions from './SampleQuestions.svelte';

  interface Props {
    questions?: string[];
    onquestionclick?: (question: string) => void;
  }
  let { questions = [], onquestionclick = () => {} }: Props = $props();

  const messages = [
    'Awaiting your command, master.',
    'The agents are restless. Give them purpose.',
    'Ready when you are. No pressure... okay, maybe a little.',
    'Spinning up neurons... just kidding, I was already ready.',
    'All systems nominal. Your move, human.',
    'The orchestrator awaits. What shall we build today?',
    'Standing by. The agents are stretching their digital legs.',
    'Another day, another chance to orchestrate greatness.',
    'Agents assembled. Awaiting mission briefing.',
    'The stage is set. You are the conductor.',
  ];

  const welcomeText = messages[Math.floor(Math.random() * messages.length)];
</script>

<div class="welcome-container">
  <svg class="welcome-orca" viewBox="0 0 220 140" xmlns="http://www.w3.org/2000/svg">
    <path class="orca-body" d="
      M 30,68
      C 28,58 38,42 58,38
      C 68,35 74,30 78,18
      C 80,12 84,12 85,18
      C 87,28 86,35 92,38
      C 112,34 148,40 172,54
      C 176,50 182,44 188,40
      C 192,38 194,42 190,46
      C 186,50 184,54 182,56
      C 186,60 188,66 184,68
      C 180,70 178,66 176,62
      C 168,72 142,78 112,76
      C 82,74 52,70 38,66
      C 34,64 30,68 30,68 Z
    "/>
    <path class="orca-detail" d="M 72,38 C 74,28 78,18 80,14"/>
    <path class="orca-detail" d="M 42,64 C 62,70 100,74 140,72 C 158,70 170,66 176,62"/>
    <path class="orca-patch" d="M 92,40 C 102,38 112,40 108,48 C 104,54 90,50 92,40 Z"/>
    <path class="orca-patch" d="M 44,52 C 50,48 60,50 56,58 C 52,62 42,58 44,52 Z"/>
    <circle class="orca-eye" cx="42" cy="54" r="2.5"/>
    <path class="orca-body" d="M 65,66 C 70,74 64,82 58,76 C 54,72 60,66 65,66 Z"/>
    <path class="orca-detail" d="M 172,54 C 176,52 180,48 184,44"/>
    <path class="orca-detail" d="M 176,62 C 180,64 184,66 186,64"/>
  </svg>
  <div class="welcome-text">{welcomeText}</div>
  {#if questions.length > 0}
    <SampleQuestions {questions} onselect={onquestionclick} />
  {/if}
</div>
