const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os'); // To determine number of CPUs

const USERNAME_NOT_FOUND_MESSAGE = 'Not Found!';
const AVAILABLE_USERNAMES_FILE = 'available_usernames.txt';

// --- Worker Thread Logic ---
async function workerCheckAvailability(browserWSEndpoint, usernamesToCheck) {
  let browser;
  const availableUsernames = [];
  try {
    browser = await puppeteer.connect({ browserWSEndpoint });
    const page = await browser.newPage();
    // Optional: Set user agent, viewport, etc. if needed
    // await page.setUserAgent('...');
    // await page.setViewport({ width: 1280, height: 800 });

    for (const username of usernamesToCheck) {
      try {
        await page.goto(`https://account.aq.com/CharPage?id=${username}`, {
          waitUntil: 'networkidle0',
          timeout: 30000
        });

        const isAvailable = await page.evaluate((msg) => {
          const serverAlert = document.querySelector('#serveralert');
          return serverAlert && serverAlert.textContent.trim() === msg;
        }, USERNAME_NOT_FOUND_MESSAGE);

        if (isAvailable) {
          console.log(`  Worker ${workerData.workerId}: Available - ${username}`);
          availableUsernames.push(username);
        } else {
          // Optional: Log taken usernames if needed
          // console.log(`  Worker ${workerData.workerId}: Taken/Error - ${username}`);
        }
      } catch (error) {
        console.error(`  Worker ${workerData.workerId}: Error checking ${username}: ${error.message}`);
        // Continue to next username on error
      }
    }
    await page.close();
  } catch (error) {
    console.error(`  Worker ${workerData.workerId}: General error: ${error}`);
  } finally {
    if (browser) {
      // We connected, not launched, so just disconnect
      await browser.disconnect();
    }
  }
  return availableUsernames;
}

if (!isMainThread) {
  // This code runs in the worker thread
  const { browserWSEndpoint, usernamesToCheck, workerId } = workerData;
  console.log(`Worker ${workerId} started with ${usernamesToCheck.length} usernames.`);
  workerCheckAvailability(browserWSEndpoint, usernamesToCheck)
    .then(availableUsernames => {
      parentPort.postMessage({ availableUsernames }); // Send results back to main thread
    })
    .catch(err => {
      // Handle potential errors during worker execution
      console.error(`Worker ${workerId} failed: ${err}`);
      parentPort.postMessage({ availableUsernames: [] }); // Send empty array on failure
    });
}

// --- Main Thread Logic ---
async function runMain() {
  if (process.argv.length < 3) {
    console.error('Usage: node main.js <path_to_usernames_file> [num_workers]');
    process.exit(1);
  }
  const inputFile = process.argv[2];
  // Determine the number of workers - use CPU count or a specific number
  const numWorkers = process.argv[3] ? parseInt(process.argv[3], 10) : os.cpus().length;
  console.log(`Using ${numWorkers} workers.`);

  let usernames;
  try {
    usernames = (await fs.readFile(inputFile, 'utf-8')).split(/\r?\n/).map(u => u.trim()).filter(Boolean);
    if (usernames.length === 0) {
      console.log('Input file is empty or contains no valid usernames.');
      return;
    }
    console.log(`Read ${usernames.length} usernames from ${inputFile}`);
  } catch (error) {
    console.error(`Error reading usernames file ${inputFile}: ${error}`);
    process.exit(1);
  }

  let browser;
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true // Or false for debugging
    });
    const browserWSEndpoint = browser.wsEndpoint();

    console.log('Distributing usernames to workers...');
    const totalUsernames = usernames.length;
    const usernamesPerWorker = Math.ceil(totalUsernames / numWorkers);
    const workerPromises = [];
    let allAvailableUsernames = [];

    for (let i = 0; i < numWorkers; i++) {
      const start = i * usernamesPerWorker;
      const end = start + usernamesPerWorker;
      const usernamesChunk = usernames.slice(start, end);

      if (usernamesChunk.length > 0) {
        const worker = new Worker(__filename, {
          workerData: {
            browserWSEndpoint,
            usernamesToCheck: usernamesChunk,
            workerId: i + 1 // Assign an ID for logging
          }
        });

        const promise = new Promise((resolve, reject) => {
          worker.on('message', (message) => {
            console.log(`Worker ${i + 1} finished, found ${message.availableUsernames.length} available usernames.`);
            allAvailableUsernames = allAvailableUsernames.concat(message.availableUsernames);
            resolve();
          });
          worker.on('error', (error) => {
            console.error(`Worker ${i + 1} encountered an error: ${error}`);
            reject(error);
          });
          worker.on('exit', (code) => {
            if (code !== 0)
              console.error(`Worker ${i + 1} stopped with exit code ${code}`);
            // Resolve even on non-zero exit to not block Promise.all, error is logged
            resolve();
          });
        });
        workerPromises.push(promise);
      }
    }

    // Wait for all workers to complete
    await Promise.all(workerPromises);

    // --- Process Results ---
    if (allAvailableUsernames.length > 0) {
      console.log(`
Found ${allAvailableUsernames.length} total available usernames. Saving to ${AVAILABLE_USERNAMES_FILE}...`);
      try {
        // Use Set to ensure uniqueness before writing
        const uniqueUsernames = [...new Set(allAvailableUsernames)];
        await fs.appendFile(AVAILABLE_USERNAMES_FILE, uniqueUsernames.join('\n') + '\n');
        console.log('Successfully saved available usernames.');
      } catch (error) {
        console.error(`Error writing to ${AVAILABLE_USERNAMES_FILE}: ${error}`);
      }
    } else {
      console.log('\nNo new available usernames found by any worker.');
    }

  } catch (error) {
    console.error(`An error occurred in the main process: ${error}`);
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
    console.log('Main process finished.');
  }
}

// --- Entry Point ---
if (isMainThread) {
  // Removed checkAvailability function from main thread scope as it's now in the worker
  // Removed run function, renamed main logic to runMain
  runMain();
} else {
  // Worker code is already defined above the main thread logic
}
