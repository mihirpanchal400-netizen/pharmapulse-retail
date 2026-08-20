import ExcelJS from 'exceljs';
import { importDef } from './fields';
import type { ImportType } from './types';

/**
 * Import Center - downloadable templates.
 *
 * A pharmacy that has no export from its old system needs a starting file. The
 * template is generated from the same field catalogue the importer matches
 * against, so a template can never drift out of step with what the importer
 * accepts - the usual failure mode of hand-maintained sample files.
 *
 * Two sheets: the data sheet the user fills in, and a field guide explaining
 * what each column means and which are mandatory.
 */

/** One example row, so the expected format of dates and prices is unambiguous. */
function exampleRow(type: ImportType): (string | number)[] {
  return importDef(type).fields.map((field) => field.example ?? '');
}

export async function buildTemplateWorkbook(type: ImportType): Promise<Buffer> {
  const def = importDef(type);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PharmaPulse Retail';
  workbook.created = new Date();

  /* ------------------------------------------------------------ data sheet */
  const sheet = workbook.addWorksheet(def.label.slice(0, 31));
  sheet.addRow(def.fields.map((field) => field.label));
  sheet.addRow(exampleRow(type));

  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  header.eachCell((cell, index) => {
    const field = def.fields[index - 1];
    if (field?.required) cell.font = { bold: true, color: { argb: 'FFB91C1C' } };
  });

  def.fields.forEach((field, index) => {
    sheet.getColumn(index + 1).width = Math.max(field.label.length + 4, 14);
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  /* ----------------------------------------------------------- field guide */
  const guide = workbook.addWorksheet('Field Guide');
  guide.addRow([`PharmaPulse Retail - ${def.label}`]);
  guide.getRow(1).font = { bold: true, size: 14 };
  guide.addRow([def.description]);
  guide.addRow([`This import writes to: ${def.affects}`]);
  guide.addRow([]);
  guide.addRow(['Column', 'Required', 'Type', 'Example', 'Notes']);
  guide.getRow(5).font = { bold: true };

  for (const field of def.fields) {
    guide.addRow([
      field.label,
      field.required ? 'Yes' : 'Optional',
      field.type,
      String(field.example ?? ''),
      field.note ?? (field.values ? `One of: ${field.values.join(', ')}` : ''),
    ]);
  }

  guide.addRow([]);
  for (const group of def.requireAnyOf ?? []) {
    guide.addRow([`At least one of these is needed on every row: ${group.label}`]);
  }
  guide.addRow([]);
  guide.addRow(['Column names do not have to match exactly - the importer recognises common variations,']);
  guide.addRow(['and anything it cannot place is mapped by hand in the Import Center before the data lands.']);

  guide.getColumn(1).width = 28;
  guide.getColumn(2).width = 12;
  guide.getColumn(3).width = 10;
  guide.getColumn(4).width = 24;
  guide.getColumn(5).width = 70;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function templateFileName(type: ImportType): string {
  return `pharmapulse-template-${type.toLowerCase().replace(/_/g, '-')}.xlsx`;
}
