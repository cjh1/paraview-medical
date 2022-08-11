import { runPipeline } from 'itk-wasm';
import { IOTypes } from 'itk-wasm';
import { readDICOMTags, readImageDICOMFileSeries } from 'itk-wasm';
import { defer, Deferred } from '../utils';
import PriorityQueue from '../utils/priorityqueue';

export interface TagSpec {
  name: string;
  tag: string;
  strconv?: boolean;
}

// volume ID => file names
export type VolumesToFilesMap = Record<string, string[]>;

interface Task {
  deferred: Deferred<any>;
  runArgs: [string, any[], any[] | null, any[] | null];
}

export class DICOMIO {
  private webWorker: any;
  private tasksRunning: boolean = false;
  private queue: PriorityQueue<Task>;
  private initializeCheck: Promise<void> | null;

  constructor() {
    this.webWorker = null;
    this.queue = new PriorityQueue<Task>();
    this.initializeCheck = null;
  }

  private async addTask(
    module: string,
    args: any[],
    inputs: any[],
    outputs: any[],
    priority = 0
  ) {
    const deferred = defer<any>();
    this.queue.push(
      {
        deferred,
        runArgs: [module, args, outputs, inputs],
      },
      priority
    );
    this.runTasks();
    return deferred.promise;
  }

  private async runTasks() {
    if (this.tasksRunning) {
      return;
    }
    this.tasksRunning = true;

    while (this.queue.size()) {
      const { deferred, runArgs } = this.queue.pop();
      // we don't want parallelization. This is to work around
      // an issue in itk.js.
      // eslint-disable-next-line no-await-in-loop
      const result = await runPipeline(this.webWorker, ...runArgs);
      deferred.resolve(result);
    }

    this.tasksRunning = false;
  }

  /**
   * Helper that initializes the webworker.
   *
   * @async
   * @throws Error initialization failed
   */
  private async initialize() {
    if (!this.initializeCheck) {
      this.initializeCheck = new Promise<void>((resolve, reject) =>
        this.addTask('dicom', [], [], [])
          .then((result) => {
            if (result.webWorker) {
              console.log(result);
              this.webWorker = result.webWorker;
              resolve();
            } else {
              reject(new Error('Could not initialize webworker'));
            }
          })
          .catch(reject)
      );
    }
    return this.initializeCheck;
  }

  /**
   * Imports files
   * @async
   * @param {File[]} files
   * @returns VolumeID[] a list of volumes parsed from the files
   */
  async categorizeFiles(files: File[]): Promise<VolumesToFilesMap> {
    await this.initialize();

    const fileData = await Promise.all(
      files.map(async (file) => {
        const buffer = await file.arrayBuffer();
        return {
          path: file.name,
          type: IOTypes.Binary,
          data: new Uint8Array(buffer)
        };
      })
    );

    const result = await this.addTask(
      // module
      'dicom',
      // args
      ['categorize', 'output.json', ...fileData.map((fd) => fd.path)],
      // inputs
      fileData,
      // outputs
      [{ path: 'output.json', type: IOTypes.Text }]
    );

    console.log('result')
    console.log(result)

    return JSON.parse(result.outputs[0].data);
  }

  /**
   * Reads a list of tags out from a given file.
   *
   * @param {File} file
   * @param {[]Tag} tags
   */
  async readTags<T extends TagSpec[]>(
    file: File,
    tags: T
  ): Promise<Record<T[number]['name'], string>> {
    const tagsArgs = tags.map((t) => t.tag);

    const sleep = (milliseconds: number) => {
      return new Promise(resolve => setTimeout(resolve, milliseconds))
    }

    while(this.tasksRunning) {
      await sleep(1000);
    }
    this.tasksRunning = true;
    const result = await readDICOMTags(this.webWorker, file, tagsArgs);
    this.tasksRunning = false;
    const tagValues = result.tags;

    return tags.reduce((info, t) => {
      const { tag, name } = t;
      if (tagValues.has(tag)) {
        return { ...info, [name]: tagValues.get(tag) };
      }
      return info;
    }, {} as Record<T[number]['name'], string>);
  }

  /**
   * Retrieves a slice of a volume.
   * @async
   * @param {File} file containing the slice
   * @param {Boolean} asThumbnail cast image to unsigned char. Defaults to false.
   * @returns ItkImage
   */
  async getVolumeSlice(file: File, asThumbnail: boolean = false) {
    await this.initialize();

    const buffer = await file.arrayBuffer();
    const result = await this.addTask(
      // module
      'dicom',
      // args
      [
        'getSliceImage',
        'output.iwi',
        file.name
        ,
        asThumbnail ? '1' : '0',
      ],
       // inputs
       [{
        path: file.name,
        type: IOTypes.Binary,
        data: new Uint8Array(buffer)
      }],
      // outputs
      [{ path: 'output.iwi', type: IOTypes.Image }],
      -10 // computing thumbnails is a low priority task
    );

    return result.outputs[0].data;
  }

  /**
   * Builds a volume for a set of files.
   * @async
   * @param {File[]} files the set of files to build volume from
   * @returns ItkImage
   */
  async buildVolume(files: File[]) {
    await this.initialize();

    const result = await readImageDICOMFileSeries(files)

    return result.image;
  }
}
