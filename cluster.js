// cluster.js
const { spawn } = require("child_process");
const path = require("path");

// Define your separate browser instances
const instances = [
  { name: "Browser-Account-1", port: 9222, profileDir: "./chrome-profile-1" },
  { name: "Browser-Account-2", port: 9223, profileDir: "./chrome-profile-2" },
  { name: "Browser-Account-3", port: 9224, profileDir: "./chrome-profile-3" },
  { name: "Browser-Account-4", port: 9225, profileDir: "./chrome-profile-4" },
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

instances.forEach((inst) => {
  console.log(`[Cluster] Launching ${inst.name} on port ${inst.port}...`);

  // 1. Launch Chrome instance with isolated profile and remote debugging port
  const chromeProcess = spawn(chromeExe, [
    `--remote-debugging-port=${inst.port}`,
    `--user-data-dir=${path.resolve(inst.profileDir)}`,
    "https://www.farmers.co.nz", // Open starting page to log in
  ]);

  chromeProcess.on("error", (err) => {
    console.error(`[Cluster] Failed to start ${inst.name}:`, err.message);
  });

  // Give Chrome 3 seconds to spin up, then start the monitor script for this instance
  setTimeout(() => {
    console.log(`[Cluster] Starting monitor worker for ${inst.name}...`);
    const monitorProcess = spawn("node", ["monitor.js", inst.port, inst.name], {
      stdio: "inherit",
    });

    monitorProcess.on("exit", (code) => {
      console.log(
        `[Cluster] Monitor for ${inst.name} exited with code ${code}`,
      );
    });
  }, 10000);
});
