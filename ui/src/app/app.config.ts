import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { MatDialogConfig, MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    // Outline form fields everywhere (dialogs and the message composer).
    {
      provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
      useValue: { appearance: 'outline', subscriptSizing: 'dynamic' },
    },

    // Spread the built-in defaults so only the listed properties are overridden.
    {
      provide: MAT_DIALOG_DEFAULT_OPTIONS,
      useValue: { ...new MatDialogConfig(), autoFocus: 'first-tabbable', restoreFocus: true },
    },
  ],
};
