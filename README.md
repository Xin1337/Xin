# Xin - AQW Username Checker

A high-performance AQW (AdventureQuest Worlds) username availability checker that uses multi-threading to efficiently check multiple usernames simultaneously.

## Features

- Multi-threaded processing using Node.js worker threads
- Automatically uses optimal number of threads based on CPU cores
- Saves found usernames to avoid rechecking
- Headless browser automation using Puppeteer
- Efficient batch processing of usernames
- Error handling and automatic recovery

## Requirements

- Node.js
- npm (Node Package Manager)

## Installation

1. Clone the repository
2. Run `npm install` to install dependencies

## Usage

Basic usage:
```bash
node main.js usernames.txt
```

With custom number of workers:
```bash
node main.js usernames.txt <number_of_workers>
```

### Input File Format
Create a text file (e.g., `usernames.txt`) with one username per line to check.

### Output
Available usernames will be saved to `available_usernames.txt`. The program will:
- Skip usernames that were previously found available
- Only add newly discovered available usernames
- Show real-time progress of the checking process

## Notes
- The tool uses headless browsing by default for better performance
- Previously found available usernames are cached to avoid unnecessary rechecks
