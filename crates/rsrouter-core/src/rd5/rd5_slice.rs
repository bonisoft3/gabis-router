//! In-memory reader for 5°×5° RD5 segment data and 1°×1° squares.
//! Decodes MicroCache cells directly from byte slices without filesystem I/O.

use std::io::{self, Error, ErrorKind};

#[cfg(feature = "rayon")]
use rayon::prelude::*;

use super::byte_reader::ByteDataReader;
use super::codec::tag_coder::TagValueValidator;
use super::crc;
use super::micro_cache::DecodedMicroCache;

pub struct Rd5Slice<'a> {
    data: &'a [u8],
    pub file_index: [u64; 25],
    pub file_header_crcs: [i32; 25],
    pub creation_time: i64,
    pub divisor: i32,
    pub elevation_type: u8,
    pub lookup_version: i16,
}

impl<'a> Rd5Slice<'a> {
    /// Parses the RD5 header and trailer from raw bytes.
    pub fn parse(data: &'a [u8]) -> io::Result<Self> {
        if data.len() < 200 {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                format!("RD5 data too short for header: {} bytes", data.len()),
            ));
        }

        let header_buf = &data[..200];
        let file_index_crc = crc::crc(header_buf);

        let mut dis = ByteDataReader::new(header_buf);
        let mut file_index = [0u64; 25];
        let mut lookup_version = -1i16;

        for (i, entry) in file_index.iter_mut().enumerate() {
            let lv = dis.read_long() as u64;
            if i == 0 {
                lookup_version = (lv >> 48) as i16;
            }
            *entry = lv & 0x0000_ffff_ffff_ffff;
        }

        let pos = file_index[24] as usize;
        let mut extra_len = 8 + 26 * 4;

        if data.len() == pos {
            return Ok(Self {
                data,
                file_index,
                file_header_crcs: [0; 25],
                creation_time: 0,
                divisor: 80,
                elevation_type: 3,
                lookup_version,
            });
        }

        if data.len() > pos + extra_len {
            extra_len += 1;
        }

        if data.len() < pos + extra_len {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!(
                    "RD5 data size {} too short for trailer, expected at least {}",
                    data.len(),
                    pos + extra_len
                ),
            ));
        }

        let trailer_buf = &data[pos..pos + extra_len];
        let mut dis = ByteDataReader::new(trailer_buf);
        let creation_time = dis.read_long();
        let crc_data = dis.read_int();

        let divisor = if crc_data == file_index_crc {
            80
        } else if (crc_data ^ 2) == file_index_crc {
            32
        } else {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "Top index checksum error in RD5 data",
            ));
        };

        let mut file_header_crcs = [0i32; 25];
        for crc_entry in &mut file_header_crcs {
            *crc_entry = dis.read_int();
        }

        let elevation_type = if dis.has_more_data() {
            dis.read_byte() as u8
        } else {
            3
        };

        Ok(Self {
            data,
            file_index,
            file_header_crcs,
            creation_time,
            divisor,
            elevation_type,
            lookup_version,
        })
    }

    /// Returns `(start_offset, end_offset)` within `data` for the given tile index `0..25`.
    #[inline]
    pub fn get_square_offsets(&self, tile_index: usize) -> (usize, usize) {
        assert!(tile_index < 25, "Tile index out of range");
        let start = if tile_index > 0 {
            self.file_index[tile_index - 1] as usize
        } else {
            200
        };
        let end = self.file_index[tile_index] as usize;
        (start, end)
    }

    /// Returns true if the 1°×1° square at `tile_index` contains data.
    #[inline]
    pub fn has_data_for_tile(&self, tile_index: usize) -> bool {
        let (start, end) = self.get_square_offsets(tile_index);
        start < end
    }

    /// Decodes all microcaches in a 1°×1° square specified by degree coordinates.
    pub fn decode_square(
        &self,
        lon_degree: i32,
        lat_degree: i32,
        way_validator: Option<&dyn TagValueValidator>,
    ) -> io::Result<Vec<DecodedMicroCache>> {
        let lon_mod5 = lon_degree % 5;
        let lat_mod5 = lat_degree % 5;
        let tile_index = (lon_mod5 * 5 + lat_mod5) as usize;

        let (start_offset, end_offset) = self.get_square_offsets(tile_index);
        if start_offset == end_offset {
            return Ok(Vec::new());
        }

        if end_offset > self.data.len() {
            return Err(Error::new(
                ErrorKind::UnexpectedEof,
                format!(
                    "Tile end offset {} exceeds data length {}",
                    end_offset,
                    self.data.len()
                ),
            ));
        }

        let square_data = &self.data[start_offset..end_offset];
        let divisor = self.divisor;
        let ncaches = (divisor * divisor) as usize;
        let indexsize = ncaches * 4;

        if square_data.len() < indexsize {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!(
                    "Square data too short for sub-index: {} < {}",
                    square_data.len(),
                    indexsize
                ),
            ));
        }

        let index_buf = &square_data[..indexsize];
        let header_crc = crc::crc(index_buf);
        if self.file_header_crcs[tile_index] != header_crc {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!("Sub-index checksum mismatch for tile {}", tile_index),
            ));
        }

        let mut dis = ByteDataReader::new(index_buf);
        let mut pos_idx = Vec::with_capacity(ncaches);
        for _ in 0..ncaches {
            pos_idx.push(dis.read_int() as usize);
        }

        let mut raw_cells = Vec::with_capacity(ncaches);
        for sub_idx in 0..ncaches {
            let start_pos = if sub_idx == 0 {
                indexsize
            } else {
                pos_idx[sub_idx - 1]
            };
            let end_pos = pos_idx[sub_idx];

            if end_pos > square_data.len() || start_pos > end_pos {
                return Err(Error::new(
                    ErrorKind::InvalidData,
                    format!("Invalid cell offset range: {}..{}", start_pos, end_pos),
                ));
            }

            let cell_bytes = &square_data[start_pos..end_pos];
            if !cell_bytes.is_empty() {
                let rel_lat = (sub_idx as i32) / divisor;
                let rel_lon = (sub_idx as i32) % divisor;
                let lon_idx = divisor * lon_degree + rel_lon;
                let lat_idx = divisor * lat_degree + rel_lat;
                raw_cells.push((cell_bytes.to_vec(), lon_idx, lat_idx));
            }
        }

        #[cfg(feature = "rayon")]
        let results: io::Result<Vec<DecodedMicroCache>> = raw_cells
            .into_par_iter()
            .map(|(bytes, lon_idx, lat_idx)| {
                DecodedMicroCache::decode(bytes, lon_idx, lat_idx, divisor, way_validator)
            })
            .filter_map(|res| match res {
                Ok(mc) if !mc.nodes.is_empty() => Some(Ok(mc)),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            })
            .collect();

        #[cfg(not(feature = "rayon"))]
        let results: io::Result<Vec<DecodedMicroCache>> = raw_cells
            .into_iter()
            .map(|(bytes, lon_idx, lat_idx)| {
                DecodedMicroCache::decode(bytes, lon_idx, lat_idx, divisor, way_validator)
            })
            .filter_map(|res| match res {
                Ok(mc) if !mc.nodes.is_empty() => Some(Ok(mc)),
                Ok(_) => None,
                Err(e) => Some(Err(e)),
            })
            .collect();

        results
    }
}
