import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import type { ModelInfo, Settings } from '../../../shared/contract';

/** Data handed to the settings dialog by the shell. */
export interface SettingsDialogData {
  settings: Settings;
  models: ModelInfo[];
}

/** Edits API keys and the defaults used by the "New chat" dialog. */
@Component({
  selector: 'app-settings-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
  templateUrl: './settings-dialog.html',
  styleUrl: './settings-dialog.css',
})
export class SettingsDialog {
  protected readonly data = inject<SettingsDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<SettingsDialog, Settings>);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly revealed = signal(false);

  protected readonly form = this.formBuilder.nonNullable.group({
    openrouterApiKey: this.data.settings.openrouter_api_key ?? '',
    braveSearchApiKey: this.data.settings.brave_search_api_key ?? '',
    defaultModel: this.data.settings.default_model ?? '',
    defaultProjectName: this.data.settings.default_project_name ?? '',
  });

  protected toggleReveal(): void {
    this.revealed.update((value) => !value);
  }

  protected onCancel(): void {
    this.dialogRef.close();
  }

  protected onSave(): void {
    const value = this.form.getRawValue();
    const settings: Settings = {};

    const openrouter = value.openrouterApiKey.trim();
    if (openrouter.length > 0) {
      settings.openrouter_api_key = openrouter;
    }
    const brave = value.braveSearchApiKey.trim();
    if (brave.length > 0) {
      settings.brave_search_api_key = brave;
    }
    if (value.defaultModel.length > 0) {
      settings.default_model = value.defaultModel;
    }
    const project = value.defaultProjectName.trim();
    if (project.length > 0) {
      settings.default_project_name = project;
    }

    this.dialogRef.close(settings);
  }
}
