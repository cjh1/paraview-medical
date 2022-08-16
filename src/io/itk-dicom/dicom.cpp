#include <cerrno>
#include <cstdio>
#include <dirent.h>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/types.h>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef WEB_BUILD
// Building with the itk.js docker container has a more recent gcc version
#include <filesystem>
namespace fs = std::filesystem;
#else
// Building locally with gcc 7.5.0 means I need -lstdc++fs and
// experimental/filesystem
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#endif

#ifdef WEB_BUILD
#include <emscripten.h>
#endif

#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>

#include "itkCastImageFilter.h"
#include "itkCommonEnums.h"
#include "itkGDCMImageIO.h"
#include "itkGDCMSeriesFileNames.h"
#include "itkImage.h"
#include "itkImageFileReader.h"
#include "itkImageFileWriter.h"
#include "itkImageIOBase.h"
#include "itkImageSeriesReader.h"
#include "itkRescaleIntensityImageFilter.h"
#include "itkVectorImage.h"

#include "itkOutputTextStream.h"
#include "itkPipeline.h"
#include "itkOutputTextStream.h"
#include "itkOutputImage.h"

#include "gdcmImageHelper.h"
#include "gdcmReader.h"

#include "charset.hpp"

using json = nlohmann::json;
using ImageType = itk::Image<float, 3>;
using ReaderType = itk::ImageFileReader<ImageType>;
using SeriesReaderType = itk::ImageSeriesReader<ImageType>;
using FileNamesContainer = std::vector<std::string>;
using DictionaryType = itk::MetaDataDictionary;
using DicomIO = itk::GDCMImageIO;
using MetaDataStringType = itk::MetaDataObject<std::string>;
using TagList = std::vector<std::string>;
// volumeID -> filenames[]
using VolumeMapType = std::unordered_map<std::string, std::vector<std::string>>;
// VolumeID[]
using VolumeIDList = std::vector<std::string>;

static const double EPSILON = 10e-5;
static VolumeMapType VolumeMap;

#ifdef WEB_BUILD
extern "C" const char *EMSCRIPTEN_KEEPALIVE unpack_error_what(intptr_t ptr) {
  auto error = reinterpret_cast<std::runtime_error *>(ptr);
  return error->what();
}
#endif

bool dirExists(std::string path) {
  struct stat buf;
  return 0 == stat(path.c_str(), &buf);
}

void replaceChars(std::string &str, char search, char replaceChar) {
  int pos;
  std::string replace(1, replaceChar);
  while ((pos = str.find(search)) != std::string::npos) {
    str.replace(pos, 1, replace);
  }
}

// convenience method for making world-writable dirs
void makedir(const std::string &dirName) {
  if (-1 == mkdir(dirName.c_str(), 0777)) {
    if (errno != EEXIST) {
      throw std::runtime_error(std::string("makedir error: ") +
                               std::strerror(errno));
    }
  }
}

// convenience method for moving files
void movefile(const std::string &src, const std::string &dst) {
  if (0 != std::rename(src.c_str(), dst.c_str())) {
    throw std::runtime_error("Failed to move file: " + src + " to " + dst +
                             ": " + std::strerror(errno));
  }
}

// doesn't actually do any length checks, or overflow checks, or anything
// really.
template <int N>
double dotProduct(const std::vector<double> &vec1,
                  const std::vector<double> &vec2) {
  double result = 0;
  for (int i = 0; i < N; i++) {
    result += vec1.at(i) * vec2.at(i);
  }
  return result;
}

std::vector<double> ReadImageOrientationValue(const std::string &filename) {
  gdcm::Reader reader;
  reader.SetFileName(filename.c_str());
  if (!reader.Read()) {
    throw std::runtime_error("gdcm: failed to read file");
  }
  const gdcm::File &file = reader.GetFile();
  // This helper method asserts that the vector has length 6.
  return gdcm::ImageHelper::GetDirectionCosinesValue(file);
}

bool areCosinesAlmostEqual(std::vector<double> cosines1,
                           std::vector<double> cosines2,
                           double epsilon = EPSILON) {
  for (int i = 0; i <= 1; i++) {
    std::vector<double> vec1{cosines1.at(i), cosines1.at(i + 1),
                             cosines1.at(i + 2)};
    std::vector<double> vec2{cosines2.at(i), cosines2.at(i + 1),
                             cosines2.at(i + 2)};
    double dot = dotProduct<3>(vec1, vec2);
    if (dot < (1 - EPSILON)) {
      return false;
    }
  }
  return true;
}

VolumeMapType SeparateOnImageOrientation(const VolumeMapType &volumeMap) {
  VolumeMapType newVolumeMap;
  // Vector< Pair< cosines, volumeID >>
  std::vector<std::pair<std::vector<double>, std::string>> cosinesToID;

  // append unique ID part to the volume ID, based on cosines
  // The format replaces non-alphanumeric chars to be semi-consistent with DICOM UID spec,
  //   and to make debugging easier when looking at the full volume IDs.
  // Format: COSINE || "S" || COSINE || "S" || ...
  //   COSINE: A decimal number -DD.DDDD gets reformatted into NDDSDDDD
  auto encodeCosinesAsIDPart = [](const std::vector<double> &cosines) {
    std::string concatenated;
    for (auto it = cosines.begin(); it != cosines.end(); ++it) {
      concatenated += std::to_string(*it);
      if (it != cosines.end() - 1) {
        concatenated += 'S';
      }
    }

    replaceChars(concatenated, '-', 'N');
    replaceChars(concatenated, '.', 'D');

    return concatenated;
  };


  for (const auto &[volumeID, names] : volumeMap) {
    for (const auto &filename : names) {
      std::vector<double> curCosines = ReadImageOrientationValue(filename);

      bool inserted = false;
      for (const auto &entry : cosinesToID) {
        if (areCosinesAlmostEqual(curCosines, entry.first)) {
          newVolumeMap[entry.second].push_back(filename);
          inserted = true;
          break;
        }
      }

      if (!inserted) {
        const auto encodedIDPart = encodeCosinesAsIDPart(curCosines);
        auto newID = volumeID + '.' + encodedIDPart;
        newVolumeMap[newID].push_back(filename);
        cosinesToID.push_back(std::make_pair(curCosines, newID));
      }
    }
  }

  return newVolumeMap;
}

/**
 * categorizeFiles extracts out the volumes contained within a set of DICOM files.
 *
 * Return a mapping of volume ID to the files containing the volume.
 */
int categorizeFiles(itk::wasm::Pipeline &pipeline) {

  // inputs
  FileNamesContainer files;
  pipeline.add_option("-f,--files", files, "File names to categorize")->required()->check(CLI::ExistingFile)->expected(1,-1);

  // outputs
  itk::wasm::OutputTextStream volumeMapJSONStream;
  pipeline.add_option("volumeMap", volumeMapJSONStream, "JSON object encoding volumeID => filenames.")->required();

  ITK_WASM_PARSE(pipeline);

  std::string path = "./";

  // parse out series
  typedef itk::GDCMSeriesFileNames SeriesFileNames;
  SeriesFileNames::Pointer seriesFileNames = SeriesFileNames::New();
  // files are all default dumped to cwd
  seriesFileNames->SetDirectory(path);
  seriesFileNames->SetUseSeriesDetails(true);
  seriesFileNames->SetGlobalWarningDisplay(false);
  seriesFileNames->AddSeriesRestriction("0008|0021");
  seriesFileNames->SetRecursive(false);
  // Does this affect series organization?
  seriesFileNames->SetLoadPrivateTags(false);

  // Obtain the initial separation of imported files into distinct volumes.
  auto &gdcmSeriesUIDs = seriesFileNames->GetSeriesUIDs();

  // The initial series UIDs are used as the basis for our volume IDs.
  VolumeMapType volumeMap;
  for (auto seriesUID : gdcmSeriesUIDs) {
    volumeMap[seriesUID] = seriesFileNames->GetFileNames(seriesUID.c_str());
  }

  // further restrict on orientation
  volumeMap = SeparateOnImageOrientation(volumeMap);

  // strip off tmp prefix
  for (auto &entry: volumeMap) {
    auto &fileNames = entry.second;
    for(auto &f : fileNames) {
      f = f.substr(path.size());
      std::cout << f << std::endl;
    }
  }

  // Generate the JSON and add to output stream
  auto volumeMapJSON = json(volumeMap);
  volumeMapJSONStream.Get() << volumeMapJSON;

  return EXIT_SUCCESS;
}

/**
 * Reads an image slice and returns the optionally thumbnailed image.
 */
int getSliceImage(itk::wasm::Pipeline &pipeline) {

  // inputs
  std::string fileName;
  pipeline.add_option("-f,--file", fileName, "File name generate image for")->required()->check(CLI::ExistingFile)->expected(1);

  bool asThumbnail = false;
  pipeline.add_option("-t,--thumbnail", asThumbnail, "Generate thumbnail image");

  ITK_WASM_PRE_PARSE(pipeline);

  // Setup reader
  typename DicomIO::Pointer dicomIO = DicomIO::New();
  dicomIO->LoadPrivateTagsOff();
  typename ReaderType::Pointer reader = ReaderType::New();
  reader->SetFileName(fileName);

  if (asThumbnail) {
    using InputImageType = ImageType;
    using OutputPixelType = uint8_t;
    using OutputImageType = itk::Image<OutputPixelType, 3>;
    using RescaleFilter =
        itk::RescaleIntensityImageFilter<InputImageType, InputImageType>;
    using CastImageFilter =
        itk::CastImageFilter<InputImageType, OutputImageType>;

    // outputs
    using WasmOutputImageType = itk::wasm::OutputImage<OutputImageType>;
    WasmOutputImageType outputImage;
    pipeline.add_option("OutputImage", outputImage, "The slice")->required();

    ITK_WASM_PARSE(pipeline);

    auto rescaleFilter = RescaleFilter::New();
    rescaleFilter->SetInput(reader->GetOutput());
    rescaleFilter->SetOutputMinimum(0);
    rescaleFilter->SetOutputMaximum(
        itk::NumericTraits<OutputPixelType>::max());

    auto castFilter = CastImageFilter::New();
    castFilter->SetInput(rescaleFilter->GetOutput());
    castFilter->Update();

    // Set the output image
    outputImage.Set(castFilter->GetOutput());
  }
  else {
    // outputs
    using WasmOutputImageType = itk::wasm::OutputImage<ImageType>;
    WasmOutputImageType outputImage;
    pipeline.add_option("OutputImage", outputImage, "The slice")->required();

    ITK_WASM_PARSE(pipeline);

    reader->Update();
    outputImage.Set(reader->GetOutput());
  }

  return EXIT_SUCCESS;
}

int main(int argc, char *argv[]) {
  std::string action;
  itk::wasm::Pipeline pipeline("VolView pipeline to access DICOM data", argc, argv);
  pipeline.add_option("-a,--action", action, "The action to run")->check(CLI::IsMember({"categorize", "getSliceImage"}));

  // Pre parse so we can get the action
  ITK_WASM_PRE_PARSE(pipeline)

  if (action == "categorize") {

    ITK_WASM_CATCH_EXCEPTION(pipeline, categorizeFiles(pipeline));

  } else if (action == "getSliceImage") {

    ITK_WASM_CATCH_EXCEPTION(pipeline, getSliceImage(pipeline));
  }

  return EXIT_SUCCESS;
}
