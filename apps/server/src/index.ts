import { runMaintenanceCli } from "./maintenanceCli";
import { startContainer } from "./processes/container";

const args = process.argv.slice(2);
void (args.length ? runMaintenanceCli(args) : startContainer()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
