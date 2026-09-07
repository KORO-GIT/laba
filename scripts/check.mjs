import { spawnSync } from 'node:child_process';

function run(command,args) {
  const result=spawnSync(command,args,{stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status||1);
}
for(const file of [
  'src/server.mjs','src/database.mjs','src/security.mjs','src/probes.mjs','src/audio-agent.mjs','src/starlink-agent.mjs','src/erp-database.mjs','src/erp-routes.mjs','src/erp-crews.mjs',
  'scripts/configure-usb-camera.mjs','scripts/configure-audio-agent.mjs','scripts/configure-starlink-agent.mjs','scripts/erp-demo.mjs','scripts/erp-browser-check.mjs','scripts/erp-crews-browser-check.mjs','scripts/erp-migration-check.mjs','scripts/erp-performance-check.mjs',
  'public/icons.js','public/home.js','public/dashboard.js','public/maintenance.js','public/admin.js','public/desktop.js','public/camera.js','public/erp.js','public/erp-theme.js','public/vendor/go2rtc/video-rtc.js','public/vendor/go2rtc/video-stream.js'
]) run(process.execPath,['--check',file]);

const candidates=[process.env.PYTHON,process.env.PYTHON3,'python3','python'].filter(Boolean);
const python=candidates.find(command=>spawnSync(command,['--version'],{encoding:'utf8'}).status===0);
if(!python)throw new Error('Python 3 is required. Install Python or set PYTHON to its executable path.');
run(python,['-m','py_compile',
  'deploy/desktop/laba-wayvnc-attach.py','deploy/audio/laba-audio-agent.py','deploy/audio/laba_clap_detector.py','deploy/starlink/laba-starlink-agent.py','deploy/starlink/laba_starlink_model.py','deploy/starlink/provision-token.py',
  'scripts/test-audio-agent-config.py','scripts/test-clap-detector.py','scripts/test-starlink-model.py'
]);
for(const file of ['scripts/test-audio-agent-config.py','scripts/test-clap-detector.py','scripts/test-starlink-model.py'])run(python,[file]);
console.log('JavaScript syntax and Python checks passed.');
