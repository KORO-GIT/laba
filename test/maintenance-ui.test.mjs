import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const maintenanceSource = await readFile(new URL('../public/maintenance.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('maintenance drag cleanup prevents stale touch previews', () => {
  const startDrag = maintenanceSource.slice(
    maintenanceSource.indexOf('function startDrag'),
    maintenanceSource.indexOf('function positionPreview')
  );
  const finishDrag = maintenanceSource.slice(
    maintenanceSource.indexOf('async function finishPointerDrag'),
    maintenanceSource.indexOf('function applyOptimisticMove')
  );

  assert.match(startDrag, /state\.dragging !== drag/);
  assert.ok(finishDrag.indexOf('clearTimeout(drag?.timer)') < finishDrag.indexOf('if (!drag?.moved)'));
  assert.doesNotMatch(maintenanceSource, /translate3d\([^\n]+rotate\(/);
});

test('maintenance board rerenders without drop flicker', () => {
  assert.match(maintenanceSource, /previousBoardSignature !== boardRenderSignature\(data\)/);
  assert.match(stylesSource, /\.drag-preview\s*\{[^}]*transition:\s*none;/s);
  assert.doesNotMatch(stylesSource, /\.maintenance-lane\s*\{[^}]*animation:/s);
});
