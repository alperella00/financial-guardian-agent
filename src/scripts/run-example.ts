import { mastra } from '../mastra';
import { scenarios } from '../data/scenarios';

// Usage: npm run example -- [scenario-name]
const name = process.argv[2] ?? 'acceleration-over-budget';
const scenario = scenarios.find((s) => s.name === name);
if (!scenario) {
  console.error(`Unknown scenario "${name}". Available: ${scenarios.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const workflow = mastra.getWorkflow('spendingAlertWorkflow');
const run = await workflow.createRun();
const result = await run.start({ inputData: scenario.input });

console.log(`Scenario: ${scenario.name} -- ${scenario.description}\n`);
if (result.status !== 'success') {
  console.error(`Workflow ${result.status}`, result);
  process.exit(1);
}
console.log(JSON.stringify(result.result, null, 2));
