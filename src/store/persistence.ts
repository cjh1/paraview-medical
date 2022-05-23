import { vtkImageData } from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkXMLImageDataWriter from '@kitware/vtk.js/IO/XML/XMLImageDataWriter'
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

import { useImageStore, ImageMetadata } from './datasets-images';
import { useViewStore } from '../store/views'
import { FileLoadResult, useDatasetStore } from './datasets';
import { FILE_READERS } from '../io';
import { Data } from '@vue/composition-api';
import { vec3, mat3, mat4 } from 'gl-matrix';

export type Manifest = { [name: string]: any };

const  serializeImageStore = async (zip: JSZip, manifest: Manifest, ) => {

    const imageStore = useImageStore();
    const datasetStore = useDatasetStore();
    const dataIndex = imageStore.$state.dataIndex;
    if (!('dataSets' in manifest)) {
        manifest.dataSets = []
    }

    const dataSets = manifest.dataSets;

    for (const id in dataIndex) {
        const path = `data/${id}.vti`;

        dataSets.push({
            id,
            'type': 'image',
            'path': path,
            'metadata': imageStore.metadata[id],
        })

        const imageData = dataIndex[id];
        const serializer = vtkXMLImageDataWriter.newInstance();
        const serializedData = serializer.write(imageData)
        zip.file(path, serializedData);
    }

    const primarySelection = datasetStore.primarySelection;
    manifest.primarySelection = primarySelection;
    zip.file('manifest.json', JSON.stringify(manifest));
    const content = await zip.generateAsync({type:"blob"});
    saveAs(content, "state.zip");
}





const  serializeViewStore = async (zip: JSZip, manifest: Manifest, ) => {

    const imageStore = useImageStore();
    const datasetStore = useDatasetStore();
    const dataIndex = imageStore.$state.dataIndex;
    if (!('dataSets' in manifest)) {
        manifest.dataSets = []
    }

    const dataSets = manifest.dataSets;

    for (const id in dataIndex) {
        const path = `data/${id}.vti`;

        dataSets.push({
            id,
            'type': 'image',
            'path': path,
            'metadata': imageStore.metadata[id],
        })

        const imageData = dataIndex[id];
        const serializer = vtkXMLImageDataWriter.newInstance();
        const serializedData = serializer.write(imageData)
        zip.file(path, serializedData);
    }

    const primarySelection = datasetStore.primarySelection;
    manifest.primarySelection = primarySelection;
    zip.file('manifest.json', JSON.stringify(manifest));
    const content = await zip.generateAsync({type:"blob"});
    saveAs(content, "state.zip");
}



export const serialize = () => {
    const zip = new JSZip();

    const manifest: Manifest = {};

    serializeImageStore(zip, manifest);



}

const makeFileSuccessStatus = (
    file: File,
    dataID: string
  ) =>
    ({
      type: 'file',
      loaded: true,
      filename: file.name,
      dataID,
      dataType: 'image',
    } as const);

const makeFileFailureStatus = (filename: string, reason: string) =>
    ({
      type: 'file',
      loaded: false,
      filename,
      error: new Error(reason),
    } as const);

type DataSet = {
    id: string;
    name: string;
    path: string;
}


export const deserialize = async (state: File[]) => {
    console.log(state)
    const imageStore = useImageStore();
    const datasetStore = useDatasetStore();
    const results = [];

    // First load the manifest
    const manifestFile = state.filter((file) => file.name === 'manifest.json')
    if (manifestFile.length === 0) {
        return [makeFileFailureStatus('manifest.json', 'State file is missing manifest')]
    }

    const manifestString  = await manifestFile[0].text();
    // TODO: Validate
    console.log(manifestString)
    const manifest = JSON.parse(manifestString)
    const dataSets = manifest.dataSets;
    const dataSetPaths = dataSets.map((dataSet: DataSet) => dataSet.path.split('/')[1])
    console.log(dataSetPaths);
    const dataSetFiles = state.filter((file) => dataSetPaths.indexOf(file.name) !== -1 )
    const dataSetIDs = dataSets.map((dataSet: DataSet) => dataSet.id)

    const pathToDataSet: { [path: string]: DataSet } = {};
    const stateIDToStoreID: { [id: string]: string } = {};
    dataSets.forEach((dataSet: DataSet) => {
        const path = dataSet.path.split('/')[1]
        pathToDataSet[path] = dataSet;
    });

    console.log(dataSetFiles)

    const statuses = Promise.all(dataSetFiles.map(async (file: File) => {
        const reader = FILE_READERS.get(file.type);
        console.log(reader)
        if (reader) {
            try {
                const dataObj = await reader(file);
                if (dataObj.isA('vtkImageData')) {
                  const dataSet = pathToDataSet[file.name]
                  const id = imageStore.addVTKImageData(
                    dataSet.name,
                    dataObj as vtkImageData
                  );
                  //imageStore.updateMetadata(id, {...dataSet.metadata});
                  stateIDToStoreID[dataSet.id] = id;
                  return makeFileSuccessStatus(file, id);
                }
            } catch (e) {
                console.log(e)
                return makeFileFailureStatus(
                    file.name,
                    `Reading ${file.name} gave an error: ${e}`
                );
            }
        }

        return makeFileFailureStatus(file.name, `Unsupported type ${file.name}`);

    })).then((statues: FileLoadResult[]) => {
        const primarySelection = manifest.primarySelection;
        if (primarySelection.type === 'image') {
            // We need to update the ID
            primarySelection.dataID = stateIDToStoreID[primarySelection.dataID];
            datasetStore.setPrimarySelection(primarySelection);
        }

        return statues;
    }) ;

    return statuses;
}