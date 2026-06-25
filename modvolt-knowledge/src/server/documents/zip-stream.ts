import yauzl from "yauzl";
import { isAcceptedDocument } from "./document-service.js";

export interface StreamedZipEntry {
  /** Holý název souboru (bez cesty uvnitř archivu). */
  fileName: string;
  buffer: Buffer;
}

export interface SkippedStreamEntry {
  fileName: string;
  reason: string;
}

/**
 * Streamovaně rozbalí ZIP archiv z cesty na disku po jednotlivých položkách
 * (yauzl, lazyEntries). Na rozdíl od adm-zip se NEČTE celý archiv do paměti —
 * v paměti je vždy jen jedna právě zpracovávaná položka, takže import zvládne
 * i víceGB archivy na malém stroji.
 *
 * Pro každou přijatelnou položku zavolá `onEntry` (čeká se na jeho dokončení,
 * než se přejde na další položku — tím se drží sekvenční zpracování a nízká
 * paměťová stopa). Nepodporované, příliš velké, skryté a macOS metadata položky
 * se přeskočí a vrátí v `skipped`. Velikost se kontroluje z hlavičky i během
 * čtení (ochrana proti „zip bombám" s podvrženou hlavičkou).
 */
export async function streamZipEntries(
  zipPath: string,
  opts: { maxEntryBytes: number; shouldStop?: () => boolean },
  onEntry: (entry: StreamedZipEntry) => Promise<void>,
): Promise<{ skipped: SkippedStreamEntry[]; stopped: boolean }> {
  const skipped: SkippedStreamEntry[] = [];
  // true = streamování bylo ukončeno předčasně přes shouldStop (zbyly položky).
  let stopped = false;

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error("ZIP archiv se nepodařilo otevřít."));
        return;
      }

      zip.on("error", reject);
      zip.on("end", () => resolve());

      zip.on("entry", (entry: yauzl.Entry) => {
        // Volající může předčasně zastavit (např. dosažen limit počtu souborů).
        if (opts.shouldStop?.()) {
          stopped = true;
          zip.close();
          resolve();
          return;
        }
        const fullName = entry.fileName;
        // Adresářové položky končí "/".
        if (/\/$/.test(fullName)) {
          zip.readEntry();
          return;
        }
        const baseName = fullName.split("/").pop() ?? fullName;
        // Skryté soubory a metadata macOS (__MACOSX/, ._soubor) ignorujeme.
        if (
          !baseName ||
          baseName.startsWith(".") ||
          fullName.startsWith("__MACOSX/")
        ) {
          zip.readEntry();
          return;
        }
        if (!isAcceptedDocument(baseName)) {
          skipped.push({ fileName: fullName, reason: "Nepodporovaný typ souboru." });
          zip.readEntry();
          return;
        }
        // Velikost z hlavičky (nekomprimovaná) – kontrola před dekompresí.
        if (entry.uncompressedSize > opts.maxEntryBytes) {
          skipped.push({ fileName: fullName, reason: "Soubor je příliš velký." });
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            skipped.push({ fileName: fullName, reason: "Položku nelze přečíst." });
            zip.readEntry();
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          let tooBig = false;
          let finished = false;

          const finish = () => {
            if (finished) return;
            finished = true;
            if (tooBig) {
              skipped.push({ fileName: fullName, reason: "Soubor je příliš velký." });
              zip.readEntry();
              return;
            }
            void onEntry({ fileName: baseName, buffer: Buffer.concat(chunks) })
              .then(() => zip.readEntry())
              .catch(reject);
          };

          stream.on("data", (c: Buffer) => {
            size += c.length;
            // Pojistka i při podvržené hlavičce velikosti.
            if (size > opts.maxEntryBytes) {
              tooBig = true;
              stream.destroy();
              return;
            }
            chunks.push(c);
          });
          stream.on("error", reject);
          stream.on("end", finish);
          stream.on("close", finish);
        });
      });

      zip.readEntry();
    });
  });

  return { skipped, stopped };
}

/**
 * Spočítá počet položek v ZIP archivu z centrálního adresáře (levné – nečte
 * obsah). Slouží k odhadu celkového počtu souborů pro ukazatel průběhu.
 * Při chybě vrací 0 (průběh se pak zobrazí bez procent).
 */
export async function countZipEntries(zipPath: string): Promise<number> {
  return new Promise<number>((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        resolve(0);
        return;
      }
      const total = zip.entryCount;
      zip.close();
      resolve(total);
    });
  });
}
