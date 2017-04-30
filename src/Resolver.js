import rp from 'request-promise';
import Promise from 'bluebird';
import semver from 'semver';
import fs from 'fs';
import Step from './Step';
import PBError from './PBError';

const writeFile = Promise.promisify(fs.writeFile);

const REGISTRY_URL = 'http://registry.npmjs.org';
const CACHE_FILE = 'package-bundle-cache.json';

export default class Resolver extends Step {
  static getMatchingVersion(pkg, versions, range) {
    let maxVersion;
    try {
      maxVersion = semver.maxSatisfying(versions, range);
      if (!maxVersion) {
        throw new Error(`Unable to find version ${range} in ${pkg}`);
      }
    } catch (err) {
      if (!versions.includes(range)) {
        throw err;
      }
      maxVersion = range;
    }
    return maxVersion;
  }

  static logPackage(pkg) {
    Step.clearLine();
    process.stdout.write(pkg);
  }

  constructor(args) {
    super(args, 1, 'Resolving dependencies');
    this.args = args;
    this.packageCache = {};
    this.downloads = new Map();

    this.packages = args.args;

    if (!this.packages.length) {
      args.help();
    }

    if (args.cache) {
      try {
        const cacheFile = fs.readFileSync(CACHE_FILE);
        this.packageCache = JSON.parse(cacheFile);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    }
  }

  init() {
    super.init();
    return Promise.mapSeries(this.packages, pkg => this.processInput(pkg))
      .then(() => this.args.cache && this.saveCache())
      .then(() => this.getResult());
  }

  getResult() {
    this.complete(`Found ${this.downloads.size} package${this.downloads.size === 1 ? '' : 's'}`);
    if (this.downloads.size === 0) {
      throw new PBError(`No new packages required.${this.args.cache ? ' Try running with the `--no-cache` option.' : ''}`, 'info');
    }
  }

  processInput(pkg) {
    let strippedAt = false;
    let name = pkg;
    let range;
    if (name.startsWith('@')) {
      name = name.substring(1);
      strippedAt = true;
    }
    if (name.includes('@')) {
      [name, range] = name.split('@');
    }
    if (strippedAt) {
      name = `@${name}`;
    }
    return this.resolveDependencies(name, range, { requested: true });
  }

  alreadyHaveValidVersion(pkg, range) {
    const versions = this.packageCache[pkg];
    return (!!versions && semver.maxSatisfying(versions, range) !== null);
  }

  resolveDependencies(pkg, range, { requested } = {}) {
    if (this.alreadyHaveValidVersion(pkg, range)) {
      return false;
    }
    return rp(`${REGISTRY_URL}/${pkg.replace('/', '%2f')}`, { json: true })
      .then((res) => {
        if (!res.versions) {
          throw new PBError(`Unable to find "${pkg}" version - ignoring.`, 'error');
        }
        const versions = Object.keys(res.versions);
        if ((this.args.allVersions && requested) || this.args.allVersionsRecursive) {
          return Promise.mapSeries(versions, v => this.getPackageVersion(res.versions[v]));
        }
        const version = range ? Resolver.getMatchingVersion(pkg, versions, range) : res['dist-tags'].latest;

        const packageObject = res.versions[version];
        return this.getPackageVersion(packageObject);
      })
      .catch(PBError, err => console.log(`${err.prettyMessage}\n`))
      .catch((err) => {
        if (err && err.statusCode === 404) {
          if (requested || !(this.args.allVersions || this.args.allVersionsRecursive)) {
            throw new PBError(`Unable to find package "${pkg}"`, 'error');
          }
        } else {
          console.log(err);
        }
      });
  }

  isCached(name, version) {
    if (this.packageCache[name] && this.packageCache[name].includes(version)) {
      return true;
    }
    this.packageCache[name] = (this.packageCache[name] || []).concat(version);
    return false;
  }

  getPackageVersion(pkg) {
    const { name, version, dist, dependencies, devDependencies, optionalDependencies } = pkg;

    if (this.isCached(name, version)) {
      return false;
    }
    const key = `${name}:${version}`;
    this.downloads.set(key, { name, version, tarball: dist.tarball });
    Resolver.logPackage(key);

    const combinedDependencies = Object.assign(
      {},
      dependencies,
      this.args.dev && devDependencies,
      this.args.optional && optionalDependencies
    );

    const keys = Object.keys(combinedDependencies);
    return Promise.map(keys, (k) => {
      const versionPattern = combinedDependencies[k];
      return this.resolveDependencies(k, versionPattern);
    }, { concurrency: this.args.concurrency || 100 });
  }

  saveCache() {
    return writeFile(CACHE_FILE, JSON.stringify(this.packageCache, null, 4));
  }
}