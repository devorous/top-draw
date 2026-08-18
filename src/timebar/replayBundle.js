/**
 * @fileoverview Single entry point for the replay/recording subsystem.
 *
 * Everything reachable from here is pulled out of the App chunk and into one
 * lazily-imported chunk (see platform/deferredModules.js). Import this barrel
 * *only* through `deferredReplay` — a static import from App.js or AppUI would
 * put the whole stack straight back on the critical path.
 *
 * The set is deliberately wide: TimeMachine, the tape recorders and the Svelte
 * surfaces that drive them form one dependency cluster, so splitting them
 * apart would leave the biggest piece (ReplayEngine, reached via TimeMachine)
 * eagerly loaded anyway.
 */

export { TimeMachine } from './TimeMachine.svelte.js';
export { TimelapseCapturer } from './TimelapseCapturer.js';
export { recorder } from '../replay/Recorder.js';
export { rollingTapeRecorder } from '../replay/RollingTapeRecorder.js';
export { RecordingController } from '../ui/RecordingController.js';

export { default as Timebar } from './Timebar.svelte';
export { default as RecorderPanel } from './RecorderPanel.svelte';
export { default as SnapshotMenu } from '../ui/svelte/SnapshotMenu.svelte';
