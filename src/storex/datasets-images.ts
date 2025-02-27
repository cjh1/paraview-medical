import { del, set } from '@vue/composition-api';
import { defineStore } from 'pinia';
import { vec3, mat3, mat4 } from 'gl-matrix';
import { vtkImageData } from '@kitware/vtk.js/Common/DataModel/ImageData';

import { useIDStore } from './id';
import {
  defaultLPSDirections,
  getLPSDirections,
  LPSDirections,
} from '../utils/lps';
import { removeFromArray } from '../utils';

export interface ImageMetadata {
  name: string;
  orientation: mat3;
  lpsOrientation: LPSDirections;
  spacing: vec3;
  origin: vec3;
  dimensions: vec3;
  worldBounds: number[]; // length 6
  worldToIndex: mat4;
  indexToWorld: mat4;
}

export const defaultImageMetadata = () => ({
  name: '(none)',
  orientation: mat3.create(),
  lpsOrientation: defaultLPSDirections(),
  spacing: vec3.fromValues(1, 1, 1),
  origin: vec3.create(),
  dimensions: vec3.fromValues(1, 1, 1),
  worldBounds: [0, 1, 0, 1, 0, 1],
  worldToIndex: mat4.create(),
  indexToWorld: mat4.create(),
});

interface State {
  idList: string[]; // list of IDs
  dataIndex: Record<string, vtkImageData>; // ID -> VTK object
  metadata: Record<string, ImageMetadata>; // ID -> metadata
}

export const useImageStore = defineStore('images', {
  state: (): State => ({
    idList: [],
    dataIndex: {},
    metadata: {},
  }),
  actions: {
    addVTKImageData(name: string, imageData: vtkImageData) {
      const idStore = useIDStore();
      const id = idStore.getNextID();

      this.idList.push(id);
      set(this.dataIndex, id, imageData);

      set(this.metadata, id, { ...defaultImageMetadata(), name });
      this.updateData(id, imageData);
      return id;
    },

    updateData(id: string, imageData: vtkImageData) {
      if (id in this.metadata) {
        const metadata: ImageMetadata = {
          name: this.metadata[id].name,
          dimensions: imageData.getDimensions() as vec3,
          spacing: imageData.getSpacing() as vec3,
          origin: imageData.getOrigin() as vec3,
          orientation: imageData.getDirection(),
          lpsOrientation: getLPSDirections(imageData.getDirection()),
          worldBounds: imageData.getBounds(),
          worldToIndex: imageData.getWorldToIndex(),
          indexToWorld: imageData.getIndexToWorld(),
        };

        set(this.metadata, id, metadata);
      }
    },

    deleteData(id: string) {
      if (id in this.dataIndex) {
        del(this.dataIndex, id);
        del(this.metadata, id);
        removeFromArray(this.idList, id);
      }
    },
  },
});
