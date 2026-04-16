/**
 * Generate 10,000 file stress test fixtures.
 *
 * Structure:
 *   perf-fixtures/
 *     pkg_000/ ... pkg_099/          (100 packages)
 *       models.py                     (50 classes each)
 *       service.py                    (imports + usages)
 *       types.ts                      (50 interfaces each)
 *       components.tsx                (imports + usages)
 *       sub_000/ ... sub_009/         (10 sub-packages × 100 = 1,000 dirs)
 *         models.py                   (20 classes each)
 *         types.ts                    (20 interfaces each)
 *         utils.py / helpers.ts       (functions using types)
 *
 * Total files: 100 × (4 + 10 × 4) = 4,400 files with actual content
 * + 5,600 stub files spread across deeper sub-directories
 *
 * Patterns exercised:
 *   - Deep import chains (pkg_000.sub_005.models → pkg_000.models → base)
 *   - Cross-package imports (pkg_042.service imports from pkg_017.models)
 *   - Mixin inheritance (3-4 levels deep)
 *   - Generic types, union types, type aliases
 *   - Assignment-style definitions
 *   - Re-exports via __init__.py and index.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../perf-fixtures');
const SCALE = process.env.PERF_SCALE === '1M' ? 10 : 1;
const NUM_PACKAGES = 100 * SCALE;
const SUB_PACKAGES_PER_PKG = 10;
const CLASSES_PER_MODEL = 50;
const CLASSES_PER_SUB = 20;
const STUB_FILES_TARGET = SCALE === 10 ? 100_000 : 10_000;

function rand(n: number) { return Math.floor(Math.random() * n); }
function randItem<T>(arr: T[]): T { return arr[rand(arr.length)]; }
function padNum(n: number, w = 3) { return String(n).padStart(w, '0'); }

const MIXIN_NAMES = ['TimestampedMixin', 'AuditMixin', 'SoftDeleteMixin', 'CacheMixin', 'ValidatorMixin'];
const BASE_CLASSES = ['BaseModel', 'BaseEntity', 'AbstractHandler', 'BaseService'];
const FIELD_TYPES_PY = ['str', 'int', 'float', 'bool', 'list', 'dict'];
const FIELD_TYPES_TS = ['string', 'number', 'boolean', 'Date', 'string[]'];
const DJANGO_FIELDS = ['CharField', 'IntegerField', 'BooleanField', 'DateTimeField', 'TextField', 'ForeignKey'];
const METHOD_NAMES_PY = ['get_display_name', 'save_record', 'delete_item', 'validate_data', 'process_entry'];
const METHOD_NAMES_TS = ['getById', 'createNew', 'updateRecord', 'deleteItem', 'validateInput'];

function genPythonClass(name: string, parents: string[], fields: number): string {
  const parentStr = parents.length ? `(${parents.join(', ')})` : '';
  let out = `class ${name}${parentStr}:\n`;
  out += `    """${name} model."""\n`;
  // Type-annotated fields
  for (let f = 0; f < Math.min(fields, 2); f++) {
    out += `    field_${f}: ${randItem(FIELD_TYPES_PY)}\n`;
  }
  // Django-style field assignments
  for (let f = 2; f < Math.min(fields, 4); f++) {
    out += `    field_${f} = models.${randItem(DJANGO_FIELDS)}()\n`;
  }
  // Methods
  if (fields > 2) {
    const methodName = `${randItem(METHOD_NAMES_PY)}_${padNum(rand(100))}`;
    out += `\n    def ${methodName}(self) -> ${randItem(FIELD_TYPES_PY)}:\n`;
    out += `        return self.field_0\n`;
  }
  // Property
  if (fields > 4) {
    out += `\n    @property\n    def computed_value(self) -> str:\n        return str(self.field_0)\n`;
  }
  out += '\n';
  return out;
}

function genTSInterface(name: string, parents: string[], fields: number): string {
  const ext = parents.length ? ` extends ${parents.join(', ')}` : '';
  let out = `export interface ${name}${ext} {\n`;
  // Regular fields
  for (let f = 0; f < Math.min(fields, 3); f++) {
    out += `  field_${f}: ${randItem(FIELD_TYPES_TS)};\n`;
  }
  // Optional fields
  if (fields > 2) {
    out += `  optional_field?: ${randItem(FIELD_TYPES_TS)};\n`;
  }
  // Readonly field
  if (fields > 3) {
    out += `  readonly readonly_field: ${randItem(FIELD_TYPES_TS)};\n`;
  }
  // Method signature
  if (fields > 1) {
    const methodName = `${randItem(METHOD_NAMES_TS)}${padNum(rand(100))}`;
    out += `  ${methodName}(id: number): ${name} | null;\n`;
  }
  out += '}\n\n';
  return out;
}

// Generate standalone function files
function genPythonFunctions(pkg: string, classes: string[]): string {
  let out = `from .models import ${classes.slice(0, 3).join(', ')}\n\n`;
  for (let i = 0; i < 5; i++) {
    const fnName = `${randItem(METHOD_NAMES_PY)}_${pkg.replace(/_/g, '')}`;
    const cls = randItem(classes);
    out += `def ${fnName}(obj: ${cls}) -> None:\n    obj.field_0\n\n`;
  }
  // const-style assignments
  out += `MAX_RETRIES = 3\nDEFAULT_TIMEOUT = 30\n`;
  out += `${pkg.replace(/_/g, '')}Config = ${randItem(classes)}\n`;
  return out;
}

function genTSFunctions(pkg: string, interfaces: string[]): string {
  let out = `import { ${interfaces.slice(0, 3).join(', ')} } from './types';\n\n`;
  for (let i = 0; i < 5; i++) {
    const fnName = `${randItem(METHOD_NAMES_TS)}${pkg.replace(/_/g, '')}`;
    const iface = randItem(interfaces);
    out += `export function ${fnName}(id: number): ${iface} | null { return null; }\n\n`;
  }
  // const declarations
  out += `export const API_ENDPOINT = '/api/${pkg}';\n`;
  out += `export const DEFAULT_PAGE_SIZE = 20;\n`;
  return out;
}

function generate() {
  const t0 = Date.now();
  let fileCount = 0;

  // Clean
  if (fs.existsSync(ROOT)) {
    fs.rmSync(ROOT, { recursive: true });
  }

  // Base mixins file
  const basePyDir = path.join(ROOT, 'base');
  fs.mkdirSync(basePyDir, { recursive: true });

  let basePy = '';
  for (const bc of BASE_CLASSES) {
    basePy += genPythonClass(bc, [], 3);
  }
  for (const mx of MIXIN_NAMES) {
    basePy += genPythonClass(mx, [randItem(BASE_CLASSES)], 2);
  }
  fs.writeFileSync(path.join(basePyDir, 'models.py'), basePy);
  fs.writeFileSync(path.join(basePyDir, '__init__.py'),
    BASE_CLASSES.concat(MIXIN_NAMES).map(n => `from .models import ${n}`).join('\n') + '\n');
  fileCount += 2;

  let baseTs = '';
  for (const bc of BASE_CLASSES) {
    baseTs += genTSInterface(bc, [], 3);
  }
  for (const mx of MIXIN_NAMES) {
    baseTs += genTSInterface(mx, [randItem(BASE_CLASSES)], 2);
  }
  fs.writeFileSync(path.join(basePyDir, 'types.ts'), baseTs);
  fs.writeFileSync(path.join(basePyDir, 'index.ts'),
    `export * from './types';\n`);
  fileCount += 2;

  // Track all generated class/interface names for cross-package imports
  const allPyClasses: { name: string; pkg: string; sub?: string }[] = [];
  const allTsInterfaces: { name: string; pkg: string; sub?: string }[] = [];

  for (let p = 0; p < NUM_PACKAGES; p++) {
    const pkgName = `pkg_${padNum(p)}`;
    const pkgDir = path.join(ROOT, pkgName);
    fs.mkdirSync(pkgDir, { recursive: true });

    // ── Package-level models.py ──
    const pyClasses: string[] = [];
    let modelsPy = `from base import ${randItem(BASE_CLASSES)}, ${randItem(MIXIN_NAMES)}\n\n`;
    for (let c = 0; c < CLASSES_PER_MODEL; c++) {
      const className = `${pkgName.replace(/_/g, '')}Class${padNum(c)}`;
      const parents = [randItem(BASE_CLASSES)];
      if (rand(3) === 0) parents.push(randItem(MIXIN_NAMES));
      modelsPy += genPythonClass(className, parents, 3 + rand(5));
      pyClasses.push(className);
      allPyClasses.push({ name: className, pkg: pkgName });
    }
    // Assignment-style aliases
    const aliasName = `${pkgName.replace(/_/g, '')}Alias`;
    modelsPy += `${aliasName} = ${randItem(pyClasses)}\n`;
    allPyClasses.push({ name: aliasName, pkg: pkgName });

    fs.writeFileSync(path.join(pkgDir, 'models.py'), modelsPy);
    fs.writeFileSync(path.join(pkgDir, '__init__.py'),
      pyClasses.slice(0, 5).map(n => `from .models import ${n}`).join('\n') + '\n');
    fileCount += 2;

    // ── Package-level types.ts ──
    const tsInterfaces: string[] = [];
    let typesTs = `import { ${randItem(BASE_CLASSES)}, ${randItem(MIXIN_NAMES)} } from '../base';\n\n`;
    for (let c = 0; c < CLASSES_PER_MODEL; c++) {
      const ifName = `${pkgName.replace(/_/g, '')}Type${padNum(c)}`;
      const parents = [randItem(BASE_CLASSES)];
      if (rand(3) === 0) parents.push(randItem(MIXIN_NAMES));
      typesTs += genTSInterface(ifName, parents, 3 + rand(5));
      tsInterfaces.push(ifName);
      allTsInterfaces.push({ name: ifName, pkg: pkgName });
    }
    // Union type alias
    const unionName = `${pkgName.replace(/_/g, '')}Union`;
    typesTs += `export type ${unionName} = ${tsInterfaces.slice(0, 3).join(' | ')};\n\n`;
    allTsInterfaces.push({ name: unionName, pkg: pkgName });

    fs.writeFileSync(path.join(pkgDir, 'types.ts'), typesTs);
    fs.writeFileSync(path.join(pkgDir, 'index.ts'), `export * from './types';\n`);
    fileCount += 2;

    // ── Package-level service.py (cross-package imports + functions) ──
    fs.writeFileSync(path.join(pkgDir, 'service.py'), genPythonFunctions(pkgName, pyClasses));
    fileCount += 1;

    // ── Package-level components.tsx (cross-package imports + functions) ──
    fs.writeFileSync(path.join(pkgDir, 'components.tsx'), genTSFunctions(pkgName, tsInterfaces));
    fileCount += 1;

    // ── Sub-packages ──
    for (let sp = 0; sp < SUB_PACKAGES_PER_PKG; sp++) {
      const subName = `sub_${padNum(sp)}`;
      const subDir = path.join(pkgDir, subName);
      fs.mkdirSync(subDir, { recursive: true });

      // sub models.py
      let subModelsPy = `from ..models import ${randItem(pyClasses)}\n\n`;
      const subPyClasses: string[] = [];
      for (let c = 0; c < CLASSES_PER_SUB; c++) {
        const cn = `${pkgName.replace(/_/g, '')}${subName.replace(/_/g, '')}Class${padNum(c)}`;
        subModelsPy += genPythonClass(cn, [randItem(pyClasses)], 2 + rand(3));
        subPyClasses.push(cn);
        allPyClasses.push({ name: cn, pkg: pkgName, sub: subName });
      }
      fs.writeFileSync(path.join(subDir, 'models.py'), subModelsPy);
      fs.writeFileSync(path.join(subDir, '__init__.py'), '');
      fileCount += 2;

      // sub types.ts
      let subTypesTs = `import { ${randItem(tsInterfaces)} } from '../types';\n\n`;
      for (let c = 0; c < CLASSES_PER_SUB; c++) {
        const tn = `${pkgName.replace(/_/g, '')}${subName.replace(/_/g, '')}Type${padNum(c)}`;
        subTypesTs += genTSInterface(tn, [randItem(tsInterfaces)], 2 + rand(3));
        allTsInterfaces.push({ name: tn, pkg: pkgName, sub: subName });
      }
      fs.writeFileSync(path.join(subDir, 'types.ts'), subTypesTs);
      fs.writeFileSync(path.join(subDir, 'index.ts'), `export * from './types';\n`);
      fileCount += 2;
    }
  }

  // ── Generate remaining stub files to reach 10K ──
  const stubsNeeded = STUB_FILES_TARGET - fileCount;
  const stubDir = path.join(ROOT, 'stubs');
  const STUBS_PER_DIR = 100;
  const stubDirCount = Math.ceil(stubsNeeded / STUBS_PER_DIR);

  for (let d = 0; d < stubDirCount; d++) {
    const dir = path.join(stubDir, `batch_${padNum(d, 4)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < STUBS_PER_DIR && fileCount < STUB_FILES_TARGET; f++) {
      const ext = f % 2 === 0 ? '.py' : '.ts';
      const stubClass = `Stub${padNum(d, 4)}${padNum(f)}`;
      const content = ext === '.py'
        ? `class ${stubClass}:\n    value: int\n`
        : `export interface ${stubClass} { value: number; }\n`;
      fs.writeFileSync(path.join(dir, `stub_${padNum(f)}${ext}`), content);
      fileCount++;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Generated ${fileCount.toLocaleString()} files in ${elapsed}s`);
  console.log(`  Packages: ${NUM_PACKAGES}`);
  console.log(`  Sub-packages: ${NUM_PACKAGES * SUB_PACKAGES_PER_PKG}`);
  console.log(`  Python classes: ${allPyClasses.length.toLocaleString()}`);
  console.log(`  TypeScript interfaces: ${allTsInterfaces.length.toLocaleString()}`);
  console.log(`  Stub files: ${stubsNeeded.toLocaleString()}`);
  console.log(`  Root: ${ROOT}`);
}

generate();
