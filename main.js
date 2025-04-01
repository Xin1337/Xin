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
        }
      } catch (error) {
        // Silently continue to next username on error
      }
    }
    await page.close();
  } catch (error) {
    // Only log critical worker errors
    console.error(`  Worker ${workerData.workerId}: General error: ${error}`);
  } finally {
    if (browser) {
      await browser.disconnect();
    }
  }
  return availableUsernames;
}

if (!isMainThread) {
  // This code runs in the worker thread
  const { browserWSEndpoint, usernamesToCheck, workerId } = workerData;
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

  let allUsernamesFromFile;
  try {
    allUsernamesFromFile = (await fs.readFile(inputFile, 'utf-8')).split(/\r?\n/).map(u => u.trim()).filter(Boolean);
    if (allUsernamesFromFile.length === 0) {
      console.log('Input file is empty or contains no valid usernames.');
      return;
    }
    console.log(`Read ${allUsernamesFromFile.length} total usernames from ${inputFile}`);
  } catch (error) {
    console.error(`Error reading usernames file ${inputFile}: ${error}`);
    process.exit(1);
  }

  // Read existing available usernames to avoid re-checking
  let existingAvailableUsernames = new Set();
  try {
    const existingContent = await fs.readFile(AVAILABLE_USERNAMES_FILE, 'utf-8');
    existingContent.split(/\r?\n/).forEach(u => {
      const trimmed = u.trim();
      if (trimmed) {
        existingAvailableUsernames.add(trimmed);
      }
    });
    console.log(`Loaded ${existingAvailableUsernames.size} existing available usernames from ${AVAILABLE_USERNAMES_FILE}.`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`'${AVAILABLE_USERNAMES_FILE}' not found, will check all usernames.`);
    } else {
      console.error(`Error reading ${AVAILABLE_USERNAMES_FILE}: ${error}`);
      // Decide if you want to exit or continue without the check
      // process.exit(1);
    }
  }

  // Filter out usernames that are already known to be available
  const usernamesToCheck = allUsernamesFromFile.filter(u => !existingAvailableUsernames.has(u));

  if (usernamesToCheck.length === 0) {
    console.log('All usernames from the input file are already listed in available_usernames.txt. No checks needed.');
    return;
  }
  console.log(`Filtered list: ${usernamesToCheck.length} usernames need to be checked online.`);


  let browser;
  try {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true // Or false for debugging
    });
    const browserWSEndpoint = browser.wsEndpoint();

    console.log('Distributing usernames to workers...');
    // Use the filtered list 'usernamesToCheck' for distribution
    const totalUsernames = usernamesToCheck.length;
    const usernamesPerWorker = Math.ceil(totalUsernames / numWorkers);
    const workerPromises = [];
    let newlyAvailableUsernames = []; // Renamed from allAvailableUsernames

    for (let i = 0; i < numWorkers; i++) {
      const start = i * usernamesPerWorker;
      const end = start + usernamesPerWorker;
      // Slice from the filtered list
      const usernamesChunk = usernamesToCheck.slice(start, end);

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
            // Collect newly found available usernames
            newlyAvailableUsernames = newlyAvailableUsernames.concat(message.availableUsernames);
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
    // Process only the newly found available usernames
    if (newlyAvailableUsernames.length > 0) {
      console.log(`
Found ${newlyAvailableUsernames.length} new available usernames. Saving to ${AVAILABLE_USERNAMES_FILE}...`);
      try {
        // Ensure uniqueness among the newly found names before writing
        const uniqueNewUsernames = [...new Set(newlyAvailableUsernames)];
        await fs.appendFile(AVAILABLE_USERNAMES_FILE, uniqueNewUsernames.join('\n') + '\n');
        console.log('Successfully saved new available usernames.');
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
