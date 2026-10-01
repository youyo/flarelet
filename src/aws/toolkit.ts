import { StackSelectionStrategy, Toolkit } from "@aws-cdk/toolkit-lib";
import type { Deployer } from "./cloud.js";
import { FlareonIoHost } from "./iohost.js";

/** @aws-cdk/toolkit-lib による Deployer。スタックの依存順（stage → version）は CDK に任せる。 */
export function toolkitDeployer(): Deployer {
  return {
    async deploy(outdir, onEvent) {
      const toolkit = new Toolkit({
        ioHost: new FlareonIoHost(onEvent),
        emojis: false,
        color: false,
      });
      const cx = await toolkit.fromAssemblyDirectory(outdir);
      const result = await toolkit.deploy(cx, {
        stacks: { strategy: StackSelectionStrategy.ALL_STACKS },
      });
      return result.stacks.map((s) => ({ name: s.stackName, outputs: { ...s.outputs } }));
    },
  };
}
