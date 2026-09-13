// The parent owns stdin as a lifetime sentinel: its pipe closes even if the
// Tauri process is terminated before it can explicitly kill this child.
if (process.env.ANNOTATION_STUDIO_STARTUP_TOKEN) {
  process.stdin.resume();
  process.stdin.once('end', () => process.exit(0));
}

await import('./server/index.ts');
