import {
  BootstrapEnvironments,
  BootstrapStackParameters,
  StackSelectionStrategy,
  Toolkit,
} from "@aws-cdk/toolkit-lib";
import type { Deployer } from "./cloud.js";
import { FlareletIoHost } from "./iohost.js";
import type { ProgressEvent } from "./iohost.js";

const newToolkit = (onEvent: (e: ProgressEvent) => void): Toolkit =>
  new Toolkit({ ioHost: new FlareletIoHost(onEvent), emojis: false, color: false });

/** @aws-cdk/toolkit-lib による Deployer。スタックの依存順（stage → version）は CDK に任せる。 */
export function toolkitDeployer(): Deployer {
  return {
    async deploy(outdir, onEvent) {
      const toolkit = newToolkit(onEvent);
      const cx = await toolkit.fromAssemblyDirectory(outdir);
      const result = await toolkit.deploy(cx, {
        stacks: { strategy: StackSelectionStrategy.ALL_STACKS },
      });
      return result.stacks.map((s) => ({ name: s.stackName, outputs: { ...s.outputs } }));
    },

    async bootstrap({ account, region, qualifier }, onEvent) {
      // `cdk bootstrap` 相当（既定テンプレート、自アカウントのみ信頼、AdministratorAccess の実行ポリシー）。
      // 後片付けできるよう削除保護は付けない。
      await newToolkit(onEvent).bootstrap(
        BootstrapEnvironments.fromList([`aws://${account}/${region}`]),
        {
          parameters: BootstrapStackParameters.exactly({ qualifier }),
          terminationProtection: false,
        },
      );
    },
  };
}
