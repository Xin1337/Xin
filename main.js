const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const puppeteer = require('puppeteer-core');
const fs = require('fs').promises;

const USERNAME_NOT_FOUND_MESSAGE = 'Not Found!';

async function checkAvailability(username) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true
  });
  const page = await browser.newPage();

  await page.goto(`https://account.aq.com/CharPage?id=${username.trim()}`, {
    waitUntil: 'networkidle0',
    timeout: 30000
  });

  const availability = await page.evaluate((USERNAME_NOT_FOUND_MESSAGE) => {
    const serverAlert = document.querySelector('#serveralert');
    if (serverAlert && serverAlert.textContent.trim() === USERNAME_NOT_FOUND_MESSAGE) {
      return true;
    }
    return false;
  }, USERNAME_NOT_FOUND_MESSAGE);

  await browser.close();

  return availability;
}

async function run() {
  const usernames = (await fs.readFile(process.argv[2], 'utf-8')).split('\n');

  for (const username of usernames) {
    if (!username.trim()) continue;

    console.log(`Checking availability of ${username.trim()}`);

    const worker = new Worker(__filename, {
      workerData: { username: username.trim() }
    });

    worker.on('message', async message => {
      if (message.availability) {
        console.log(`Username ${username.trim()} is available!`);
        const availableUsernames = (await fs.readFile('available_usernames.txt', 'utf-8')).split('\n');
        if (!availableUsernames.includes(username.trim())) {
          await fs.appendFile('available_usernames.txt', username.trim() + '\n');
        }
      } else {
        console.log(`Username ${username.trim()} is taken.`);
      }
      console.log('------------------------');
    });

    worker.on('error', error => {
      console.error(`Worker for ${username.trim()} encountered an error: ${error}`);
    });

    worker.on('exit', code => {
      if (code !== 0) {
        console.error(`Worker for ${username.trim()} exited with code ${code}`);
      }
    });
  }
}

if (isMainThread) {
  run();
} else {
  const { username } = workerData;
  checkAvailability(username.trim())
    .then(availability => parentPort.postMessage({ availability }))
    .catch(error => console.error(`Worker for ${username.trim()} encountered an error: ${error}`));
}
