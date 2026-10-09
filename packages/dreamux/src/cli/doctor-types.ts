/**
 * One `dreamux doctor` result row.
 *
 * Shared by `doctor.ts` (the checks it runs directly) and `doctor-plugins.ts`
 * (the plugin-load rows it contributes); declared here, in neither, so
 * neither file has to import the other for a plain result shape.
 */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity?: 'warn';
}
