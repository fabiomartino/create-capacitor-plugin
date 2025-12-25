import { chmod, mkdir, writeFile } from 'fs/promises';
import { render } from 'ejs';
import { createReadStream } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { Parser } from 'tar';

import type { OptionValues } from './options';

const EJS_EXTENSION = '.ejs';

export const CAPACITOR_VERSION = '8.0.0';

const TEMPLATE_PATH = resolve(__dirname, '..', 'assets', 'plugin-template.tar.gz');

const WWW_TEMPLATE_PATH = resolve(__dirname, '..', 'assets', 'www-template.tar.gz');

/**
 * Extracts a template from a gzipped tarball and processes all `.ejs` files.
 * @param dir The destination directory.
 * @param details The template variables.
 * @param type The type of template to extract.
 */
export const extractTemplate = async (
  dir: string,
  details: OptionValues,
  type: 'PLUGIN_TEMPLATE' | 'WWW_TEMPLATE',
): Promise<void> => {
  await mkdir(dir, { recursive: true });

  // Prepare the EJS context object with all necessary variables
  const locals = {
    capacitorVersion: CAPACITOR_VERSION,
    packageName: details.name,
    packageId: details['package-id'],
    nativeName: packageNameToNative(details.name),
    className: details['class-name'],
    class: details['class-name'],
    javaPath: join((details['package-id'] ?? '').split('.').join(sep), details['class-name']),
    repoUrl: details.repo ? details.repo.replace(/\/$/, '') : '',
    author: details.author,
    license: details.license,
    description: details.description,
  };

  const templatePath = type === 'PLUGIN_TEMPLATE' ? TEMPLATE_PATH : WWW_TEMPLATE_PATH;

  // Array to track all async file write operations to ensure completion before returning
  const pendingOperations: Promise<void>[] = [];

  const parser = new Parser();

  // FIX: Type assertion (as any) used to handle events due to incomplete '@types/tar' definitions.
  // We need to listen to 'entry' events to process files individually.
  (parser as any).on('entry', (entry: any) => {
    // Ignore non-file entries (directories, symbolic links) and resume the stream to prevent blocking.
    if (entry.type !== 'File') {
      entry.resume();
      return;
    }

    const chunks: Buffer[] = [];

    // Accumulate file data chunks
    entry.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));

    // Once the file is fully read from the tar stream
    entry.on('end', () => {
      const content = Buffer.concat(chunks);
      const originalPath = entry.path;

      // Start processing (render + write) and track the promise
      const operation = (async () => {
        try {
          // 1. Render the destination path using EJS to handle dynamic filenames/folders
          const destPath = render(originalPath, { locals });
          const finalPath = resolve(dir, destPath);

          // 2. Render content and write to disk
          if (originalPath.endsWith(EJS_EXTENSION)) {
            // Remove the .ejs extension for the final file
            const finalFilePath = finalPath.substring(0, finalPath.length - EJS_EXTENSION.length);

            // Render the EJS template content
            const renderedContent = render(content.toString('utf8'), { locals });

            await mkdir(dirname(finalFilePath), { recursive: true });
            await writeFile(finalFilePath, renderedContent, 'utf8');
            if (finalFilePath.endsWith('gradlew')) {
              await chmod(finalFilePath, 0o755);
            }
          } else {
            // Write binary or static files as-is
            await mkdir(dirname(finalPath), { recursive: true });
            await writeFile(finalPath, content);
            if (finalPath.endsWith('gradlew')) {
              await chmod(finalPath, 0o755);
            }
          }
        } catch (err) {
          console.error(`Error processing file ${originalPath}:`, err);
          throw err;
        }
      })();

      pendingOperations.push(operation);
    });
  });

  // Pipe the stream and wait for parsing to complete
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(templatePath);

    source.on('error', (err) => reject(err));

    // FIX: Type assertion again for 'error' and 'end' listeners on the parser
    (parser as any).on('error', (err: Error) => reject(err));
    (parser as any).on('end', () => resolve());

    source.pipe(parser);
  });

  // Wait for all file write operations to finish
  await Promise.all(pendingOperations);
};

/**
 * Converts an NPM package name to a Native Class name (PascalCase).
 * Removes NPM scopes (e.g. @scope/) and converts kebab-case to PascalCase.
 * * Example: @ionic/pwa-elements -> PwaElements
 * Example: capacitor-plugin-camera -> CapacitorPluginCamera
 */
export function packageNameToNative(name: string): string {
  return name
    .replace(/^@[\w-]+\//, '') // Remove scope (e.g. @ionic/pwa-elements)
    .replace(/-(\w)/g, (_, c) => c.toUpperCase()) // kebab-to-camel
    .replace(/^(\w)/, (_, c) => c.toUpperCase()); // UpperFirst
}
