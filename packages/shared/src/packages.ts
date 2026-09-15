/** The shared npm project in `<dataDir>/packages` (spec §11.1, §11.5). */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_NPMRC = `registry=${DEFAULT_REGISTRY}\n`;

export interface PackagesManifest {
  name: string;
  private: boolean;
  dependencies: Record<string, string>;
  trustedDependencies: string[];
}

export function defaultPackagesManifest(): PackagesManifest {
  return { name: "jslab-packages", private: true, dependencies: {}, trustedDependencies: [] };
}
