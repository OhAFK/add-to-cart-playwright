// cluster.js
const { spawn } = require("child_process");
const path = require("path");
const { randomUUID } = require("crypto");

// Define your separate browser instances
const instances = [
  { name: "Browser-Account-1", port: 9222, profileDir: "./chrome-profile-1" },
  // { name: "Browser-Account-2", port: 9223, profileDir: "./chrome-profile-2" },
  // { name: "Browser-Account-3", port: 9224, profileDir: "./chrome-profile-3" },
  // { name: "Browser-Account-4", port: 9225, profileDir: "./chrome-profile-4" },
  // { name: "Browser-Account-5", port: 9226, profileDir: "./chrome-profile-5" },
  // { name: "Browser-Account-6", port: 9227, profileDir: "./chrome-profile-6" },
  // { name: "Browser-Account-7", port: 9228, profileDir: "./chrome-profile-7" },
  // { name: "Browser-Account-8", port: 9229, profileDir: "./chrome-profile-8" },
  // { name: "Browser-Account-9", port: 9230, profileDir: "./chrome-profile-9" },
  // { name: "Browser-Account-10", port: 9231, profileDir: "./chrome-profile-10" },
  // { name: "Browser-Account-11", port: 9232, profileDir: "./chrome-profile-11" },
];

function getChromePath() {
  // Adjust path if needed based on your OS
  switch (process.platform) {
    case "win32":
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    default:
      return "google-chrome";
  }
}

const chromeExe = getChromePath();
const MONITOR_RESTART_DELAY_MS = 5000;
const CHROME_STARTUP_DELAY_MS = 10000;
const MONITOR_SUCCESS_ROTATION_EXIT_CODE = 75;
const MONITOR_ERROR_ROTATION_EXIT_CODE = 76;
let nextRestartPort = Math.max(...instances.map((inst) => inst.port)) + 1;

function getUniqueBrowserInstance() {
  const profileId = randomUUID();
  return {
    name: `Browser-Profile-${profileId}`,
    port: nextRestartPort++,
    profileDir: `./chrome-profile-${profileId}`,
  };
}

function launchChrome(inst) {
  console.log(`[Cluster] Launching ${inst.name} on port ${inst.port}...`);
  const chromeProcess = spawn(
    chromeExe,
    [
      `--remote-debugging-port=${inst.port}`,
      `--user-data-dir=${path.resolve(inst.profileDir)}`,
      "https://www.farmers.co.nz",
    ],
    {
      detached: true,
      stdio: "ignore",
    },
  );

  chromeProcess.unref();
  chromeProcess.on("error", (err) => {
    console.error(`[Cluster] Failed to start ${inst.name}:`, err.message);
  });
}

function startMonitor(inst) {
  console.log(`[Cluster] Starting monitor worker for ${inst.name}...`);
  const monitorProcess = spawn("node", ["monitor.js", inst.port, inst.name], {
    stdio: "inherit",
  });
  let restartScheduled = false;

  const scheduleMonitorRestart = () => {
    if (restartScheduled) return;
    restartScheduled = true;
    setTimeout(() => startMonitor(inst), MONITOR_RESTART_DELAY_MS);
  };

  const scheduleBrowserRestart = (nextInst) => {
    if (restartScheduled) return;
    restartScheduled = true;
    console.log(
      `[Cluster] Starting a new profile after ${inst.name} requested browser rotation: ${nextInst.name} (${nextInst.profileDir}) on port ${nextInst.port}.`,
    );
    setTimeout(() => {
      launchChrome(nextInst);
      setTimeout(() => startMonitor(nextInst), CHROME_STARTUP_DELAY_MS);
    }, MONITOR_RESTART_DELAY_MS);
  };

  monitorProcess.on("error", (err) => {
    console.error(
      `[Cluster] Failed to start monitor for ${inst.name}:`,
      err.message,
    );
    scheduleMonitorRestart();
  });

  monitorProcess.on("exit", (code, signal) => {
    console.log(
      `[Cluster] Monitor for ${inst.name} exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
    );
    switch (code) {
      case MONITOR_SUCCESS_ROTATION_EXIT_CODE:
      case MONITOR_ERROR_ROTATION_EXIT_CODE:
        scheduleBrowserRestart(getUniqueBrowserInstance());
        break;
      default:
        scheduleMonitorRestart();
    }
  });
}

instances.forEach((inst) => {
  launchChrome(inst);
  setTimeout(() => {
    startMonitor(inst);
  }, CHROME_STARTUP_DELAY_MS);
});
