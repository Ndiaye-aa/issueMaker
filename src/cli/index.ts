#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { registerAnalyzeCommand } from './commands/analyze.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerBacklogCommand } from './commands/backlog.js';
import { registerProcessCommand } from './commands/process.js';
import { registerPublishCommand } from './commands/publish.js';

const program = new Command();

program
  .name('sdd-bot')
  .description(
    'Transforma um Documento de Design de Software (SDD) em backlog estruturado e publica issues no GitHub.',
  )
  .version('0.1.0');

registerAnalyzeCommand(program);
registerPlanCommand(program);
registerBacklogCommand(program);
registerProcessCommand(program);
registerPublishCommand(program);

program.parse(process.argv);
