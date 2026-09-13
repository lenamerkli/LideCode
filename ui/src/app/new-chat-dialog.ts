import { Component, inject } from '@angular/core';
import {
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ModelInfo, VolumeMount } from '../../../shared/contract';
import type { CreateChatOptions } from './chat-store';
import { bridge } from './lidecode-bridge';

/** Data handed to the dialog by the shell. */
export interface NewChatDialogData {
  models: ModelInfo[];
  defaultModel: string;
  defaultProjectName: string;
  defaultAllowWeb: boolean;
  defaultHostTools: boolean;
  /** True when the values were copied from the open chat (shows a note). */
  prefilled?: boolean;
  defaultTemperature?: number;
  defaultSystemPromptExt?: string;
  /** Host directories of the open chat, reused as the dialog's initial mounts. */
  defaultMounts?: VolumeMount[];
}

/** Form value returned by the dialog (the shell feeds it to `ChatStore.createChat`). */
export type NewChatDialogResult = CreateChatOptions;

/** One row of the "Mounted directories" list. */
type MountForm = FormGroup<{
  host: FormControl<string>;
  container: FormControl<string>;
  readOnly: FormControl<boolean>;
}>;

/** Modal form used to create a chat (model, project, mounts, sandbox options). */
@Component({
  selector: 'app-new-chat-dialog',
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
  ],
  templateUrl: './new-chat-dialog.html',
  styleUrl: './new-chat-dialog.css',
})
export class NewChatDialog {
  protected readonly data = inject<NewChatDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject(MatDialogRef<NewChatDialog, NewChatDialogResult>);
  private readonly formBuilder = inject(FormBuilder);

  /** Host directories to mount into the sandbox; empty means it is isolated. */
  protected get mounts(): FormArray<MountForm> {
    return this.form.controls.mounts;
  }

  protected readonly form = this.formBuilder.group({
    model: [this.data.defaultModel, Validators.required],
    projectName: [this.data.defaultProjectName, Validators.required],
    allowWeb: [this.data.defaultAllowWeb],
    hostTools: [this.data.defaultHostTools],
    systemPromptExt: [this.data.defaultSystemPromptExt ?? ''],
    temperature: this.formBuilder.control<number | null>(this.data.defaultTemperature ?? null, [
      Validators.min(0),
      Validators.max(2),
    ]),
    mounts: this.formBuilder.array<MountForm>(
      (this.data.defaultMounts ?? []).map((mount) => this.createMountFromVolume(mount)),
    ),
  });

  /** Append a mount row, pre-filling the container path for this project. */
  protected addMount(): void {
    const project = (this.form.controls.projectName.value ?? '').trim();
    const container = project.length > 0 ? '/home/agent/' + project : '/home/agent/';
    this.mounts.push(this.createMount(container));
    this.mounts.markAsDirty();
  }

  protected removeMount(index: number): void {
    this.mounts.removeAt(index);
    this.mounts.markAsDirty();
  }

  /** Fill a row's host path from the native directory picker. */
  protected async browse(index: number): Promise<void> {
    const row = this.mounts.at(index);
    const path = await bridge().files.pickDirectory();
    if (path !== null) {
      row.controls.host.setValue(path);
      row.controls.host.markAsDirty();
    }
  }

  protected onCancel(): void {
    this.dialogRef.close();
  }

  protected onCreate(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const result: NewChatDialogResult = {
      model: value.model ?? '',
      projectName: (value.projectName ?? '').trim(),
      allowWeb: value.allowWeb ?? false,
      hostTools: value.hostTools ?? true,
    };
    if (value.temperature !== null) {
      result.temperature = value.temperature;
    }
    const extension = (value.systemPromptExt ?? '').trim();
    if (extension.length > 0) {
      result.systemPromptExt = extension;
    }
    if (value.mounts.length > 0) {
      result.volumes = value.mounts.map((mount): VolumeMount => {
        const host = mount.host.trim();
        const container = mount.container.trim();
        // Omit the mode unless read-only so Docker keeps its `rw` default.
        return mount.readOnly ? [host, container, 'ro'] : [host, container];
      });
    }
    this.dialogRef.close(result);
  }

  private createMount(container: string, host = '', readOnly = false): MountForm {
    return this.formBuilder.nonNullable.group({
      host: [host, Validators.required],
      container: [container, [Validators.required, Validators.pattern(/^\//)]],
      readOnly: [readOnly],
    });
  }

  /** Build a form row from a persisted `[host, container, mode?]` volume mount. */
  private createMountFromVolume(volume: VolumeMount): MountForm {
    const [host, container, mode] = volume;
    return this.createMount(container, host, mode === 'ro');
  }
}
