#!/usr/bin/env node

import 'dotenv/config';
import { validateCallArchitectureConfig } from '../services/call-queue.js';

const result = validateCallArchitectureConfig(process.env);

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
