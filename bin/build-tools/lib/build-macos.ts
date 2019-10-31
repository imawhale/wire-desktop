/*
 * Wire
 * Copyright (C) 2019 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {flatAsync as buildPkg} from 'electron-osx-sign';
import electronPackager from 'electron-packager';
import fs from 'fs-extra';
import path from 'path';

import {execSync} from 'child_process';
import {getLogger} from '../../bin-utils';
import {getCommonConfig} from './commonConfig';
import {CommonConfig, MacOSConfig} from './Config';

const libraryName = path.basename(__filename).replace('.ts', '');
const logger = getLogger('build-tools', libraryName);

export function buildMacOSConfig(
  wireJsonPath: string,
  envFilePath: string,
  signManually?: boolean,
): {macOSConfig: MacOSConfig; packagerConfig: electronPackager.Options} {
  const wireJsonResolved = path.resolve(wireJsonPath);
  const envFileResolved = path.resolve(envFilePath);
  const {commonConfig} = getCommonConfig(envFileResolved, wireJsonResolved);

  const macOsDefaultConfig: MacOSConfig = {
    bundleId: 'com.wearezeta.zclient.mac',
    category: 'public.app-category.social-networking',
    certNameApplication: null,
    certNameInstaller: null,
    notarizeAppleId: null,
    notarizeApplePassword: null,
  };

  const macOSConfig: MacOSConfig = {
    ...macOsDefaultConfig,
    bundleId: process.env.MACOS_BUNDLE_ID || macOsDefaultConfig.bundleId,
    certNameApplication: process.env.MACOS_CERTIFICATE_NAME_APPLICATION || macOsDefaultConfig.certNameApplication,
    certNameInstaller: process.env.MACOS_CERTIFICATE_NAME_INSTALLER || macOsDefaultConfig.certNameInstaller,
    notarizeAppleId: process.env.MACOS_NOTARIZE_APPLE_ID || macOsDefaultConfig.notarizeAppleId,
    notarizeApplePassword: process.env.MACOS_NOTARIZE_APPLE_PASSWORD || macOsDefaultConfig.notarizeApplePassword,
  };

  const packagerConfig: electronPackager.Options = {
    appBundleId: macOSConfig.bundleId,
    appCategoryType: 'public.app-category.social-networking',
    appCopyright: commonConfig.copyright,
    appVersion: commonConfig.version,
    asar: commonConfig.enableAsar,
    buildVersion: commonConfig.buildNumber,
    darwinDarkModeSupport: true,
    dir: '.',
    extendInfo: 'resources/macos/custom.plist',
    helperBundleId: `${macOSConfig.bundleId}.helper`,
    icon: 'resources/macos/logo.icns',
    ignore: /electron\/renderer\/src/,
    name: commonConfig.name,
    out: commonConfig.buildDir,
    overwrite: true,
    platform: 'mas',
    protocols: [{name: `${commonConfig.name} Core Protocol`, schemes: [commonConfig.customProtocolName]}],
    prune: true,
    quiet: false,
  };

  if (!signManually) {
    if (macOSConfig.certNameApplication) {
      packagerConfig.osxSign = {
        entitlements: 'resources/macos/entitlements/parent.plist',
        'entitlements-inherit': 'resources/macos/entitlements/child.plist',
        identity: macOSConfig.certNameApplication,
      };
    }

    if (macOSConfig.notarizeAppleId && macOSConfig.notarizeApplePassword) {
      packagerConfig.osxNotarize = {
        appleId: macOSConfig.notarizeAppleId,
        appleIdPassword: macOSConfig.notarizeApplePassword,
      };
    }
  }

  return {macOSConfig, packagerConfig};
}

export async function buildMacOSWrapper(
  packagerConfig: electronPackager.Options,
  macOSConfig: MacOSConfig,
  packageJsonPath: string,
  wireJsonPath: string,
  envFilePath: string,
  signManually?: boolean,
): Promise<void> {
  const wireJsonResolved = path.resolve(wireJsonPath);
  const packageJsonResolved = path.resolve(packageJsonPath);
  const envFileResolved = path.resolve(envFilePath);
  const {defaultConfig, commonConfig} = getCommonConfig(envFileResolved, wireJsonResolved);

  logger.info(`Building ${commonConfig.name} ${commonConfig.version} for macOS ...`);

  const originalPackageJson = await fs.readJson(packageJsonResolved);

  await fs.writeJson(
    packageJsonResolved,
    {...originalPackageJson, productName: commonConfig.name, version: commonConfig.version},
    {spaces: 2},
  );
  await fs.writeJson(wireJsonResolved, commonConfig, {spaces: 2});

  try {
    let buildDir = await electronPackager(packagerConfig);

    if (Array.isArray(buildDir)) {
      buildDir = buildDir[0];
    }

    logger.log(`Built app in "${buildDir}".`);

    if (macOSConfig.certNameInstaller) {
      const appFile = path.join(buildDir, `${commonConfig.name}.app`);
      await fs.ensureDir(commonConfig.distDir);
      const pkgFile = path.join(commonConfig.distDir, `${commonConfig.name}.pkg`);

      if (signManually) {
        await manualMacOSSign(appFile, pkgFile, commonConfig, macOSConfig);
      } else {
        await buildPkg({
          app: appFile,
          identity: macOSConfig.certNameInstaller,
          pkg: pkgFile,
          platform: 'mas',
        });
      }

      logger.log(`Built installer in "${commonConfig.distDir}".`);
    }
  } finally {
    await fs.writeJson(packageJsonResolved, originalPackageJson, {spaces: 2});
    await fs.writeJson(wireJsonResolved, defaultConfig, {spaces: 2});
  }
}

export async function manualMacOSSign(
  appFile: string,
  pkgFile: string,
  commonConfig: CommonConfig,
  macOSConfig: MacOSConfig,
): Promise<void> {
  const inheritEntitlements = 'resources/macos/entitlements/child.plist';
  const mainEntitlements = 'resources/macos/entitlements/parent.plist';

  if (macOSConfig.certNameApplication) {
    const filesToSign = [
      'Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
      'Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib',
      'Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib',
      'Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib',
      'Frameworks/Electron Framework.framework/Versions/A/Libraries/libswiftshader_libEGL.dylib',
      'Frameworks/Electron Framework.framework/Versions/A/Libraries/libswiftshader_libGLESv2.dylib',
      'Frameworks/Electron Framework.framework/',
      `Frameworks/${commonConfig.name} Helper.app/Contents/MacOS/${commonConfig.name} Helper`,
      `Frameworks/${commonConfig.name} Helper.app/`,
      `Frameworks/${commonConfig.name} Helper (GPU).app/Contents/MacOS/${commonConfig.name} Helper (GPU)`,
      `Frameworks/${commonConfig.name} Helper (GPU).app/`,
      `Frameworks/${commonConfig.name} Helper (Plugin).app/Contents/MacOS/${commonConfig.name} Helper (Plugin)`,
      `Frameworks/${commonConfig.name} Helper (Plugin).app/`,
      `Frameworks/${commonConfig.name} Helper (Renderer).app/Contents/MacOS/${commonConfig.name} Helper (Renderer)`,
      `Frameworks/${commonConfig.name} Helper (Renderer).app/`,
      `Library/LoginItems/${commonConfig.name} Login Helper.app/Contents/MacOS/${commonConfig.name} Login Helper`,
      `Library/LoginItems/${commonConfig.name} Login Helper.app/`,
    ];

    for (const fileName of filesToSign) {
      const fullPath = `${appFile}/Contents/${fileName}`;
      execSync(
        `codesign --deep -fs '${macOSConfig.certNameApplication}' --entitlements '${inheritEntitlements}' '${fullPath}'`,
      );
    }

    if (macOSConfig.certNameInstaller) {
      const appExecutable = `${appFile}/Contents/MacOS/${commonConfig.name}`;
      execSync(
        `codesign --deep -fs '${macOSConfig.certNameApplication}' --entitlements '${inheritEntitlements}' '${appExecutable}'`,
      );
      execSync(
        `codesign --deep -fs '${macOSConfig.certNameApplication}' --entitlements '${mainEntitlements}' '${appFile}'`,
      );
      execSync(
        `productbuild --component '${appFile}' /Applications --sign '${macOSConfig.certNameInstaller}' '${pkgFile}'`,
      );
    }
  }
}
