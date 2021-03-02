import os from 'os';
import path from 'path';

import { registryFile } from '../../constants';
import { Chain } from '../types';
import { deriveAddress } from '../utils/derive-address';
import { getDefaultHomePath } from '../utils/get-default-home-path';
import { loadAndValidateApp } from '../utils/load-and-validate-app';
import { loadAndValidateRegistry } from '../utils/load-and-validate-registry';
import { resolveMnemonicOption } from '../utils/resolve-mnemonic-option';
import { resolveOption } from '../utils/resolve-option';
import { resolveRequiredOption } from '../utils/resolve-required-option';

export type Flags = {
  readonly interactive: boolean;
  readonly home?: string;
  readonly keyFile?: string;
  readonly mnemonic?: string;
};

export type Options = {
  readonly home: string;
  readonly mnemonic: string;
};

export async function keysList(flags: Flags) {
  const home = resolveRequiredOption('home')(
    flags.home,
    process.env.RELAYER_HOME,
    getDefaultHomePath
  );
  const app = loadAndValidateApp(home);
  const keyFile = resolveOption(
    flags.keyFile,
    process.env.KEY_FILE,
    app?.keyFile
  );

  const options: Options = {
    home,
    mnemonic: await resolveMnemonicOption({
      interactive: flags.interactive,
      mnemonic: flags.mnemonic,
      keyFile: keyFile,
      app,
    }),
  };

  await run(options);
}

export async function getAddresses(
  registryChains: Record<string, Chain>,
  mnemonic: string
): Promise<[chain: string, data: Chain, address: string][]> {
  const chains = Object.entries(registryChains);

  return (
    await Promise.all(
      chains.map(([, data]) =>
        deriveAddress(mnemonic, data.prefix, data.hd_path)
      )
    )
  ).map((address, index) => [chains[index][0], chains[index][1], address]);
}

export async function run(options: Options) {
  const registryFilePath = path.join(options.home, registryFile);
  const registry = loadAndValidateRegistry(registryFilePath);

  const addresses = (await getAddresses(registry.chains, options.mnemonic))
    .map(([chain, , address]) => `${chain}: ${address}`)
    .join(os.EOL);

  console.log(addresses);
}
