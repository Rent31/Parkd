//! Experimental in-memory stripe codec. This is not a storage format and is
//! not used by the block manager. The manifest must come from a trusted source.

use garage_util::data::{blake2sum, Hash};
use reed_solomon_erasure::galois_8::ReedSolomon;

const MAX_STRIPE_BYTES: usize = 1024 * 1024;
const MAX_SHARDS: usize = 16;

/// Metadata required to validate and reconstruct one in-memory stripe.
/// This structure is not a stable on-disk or RPC format.
#[derive(Clone, Debug)]
pub struct StripeManifest {
	data_shards: usize,
	parity_shards: usize,
	original_len: usize,
	shard_len: usize,
	data_hash: Hash,
	shard_hashes: Vec<Hash>,
}

/// Encode one stripe. Shard positions are significant and the returned
/// manifest must be protected independently from the shards.
pub fn encode(data: &[u8], data_shards: usize, parity_shards: usize) -> Result<(StripeManifest, Vec<Vec<u8>>), String> {
	let total = data_shards.checked_add(parity_shards).ok_or("Invalid shard counts")?;
	if data_shards == 0 || parity_shards == 0 || total > MAX_SHARDS || data.len() > MAX_STRIPE_BYTES {
		return Err("Invalid stripe size or shard counts".into());
	}
	let codec = ReedSolomon::new(data_shards, parity_shards).map_err(|e| e.to_string())?;
	let shard_len = data.len().div_ceil(data_shards).max(1);
	let mut shards = vec![vec![0u8; shard_len]; total];
	for (index, chunk) in data.chunks(shard_len).enumerate() {
		shards[index][..chunk.len()].copy_from_slice(chunk);
	}
	codec.encode(&mut shards).map_err(|e| e.to_string())?;
	let manifest = StripeManifest {
		data_shards,
		parity_shards,
		original_len: data.len(),
		shard_len,
		data_hash: blake2sum(data),
		shard_hashes: shards.iter().map(|shard| blake2sum(shard)).collect(),
	};
	Ok((manifest, shards))
}

/// Recover a stripe from indexed shards. Missing, truncated or corrupt shards
/// are treated as erasures. No bytes are returned unless all reconstructed
/// shard hashes and the original data hash match the trusted manifest.
pub fn reconstruct_shards(manifest: &StripeManifest, supplied: &[Option<Vec<u8>>]) -> Result<Vec<Vec<u8>>, String> {
	let total = manifest.data_shards.checked_add(manifest.parity_shards).ok_or("Invalid manifest")?;
	if manifest.data_shards == 0 || manifest.parity_shards == 0 || total > MAX_SHARDS
		|| manifest.original_len > MAX_STRIPE_BYTES || manifest.shard_len == 0
		|| manifest.shard_len != manifest.original_len.div_ceil(manifest.data_shards).max(1)
		|| manifest.shard_hashes.len() != total || supplied.len() != total
	{
		return Err("Invalid manifest or shard count".into());
	}
	let mut shards: Vec<Option<Vec<u8>>> = supplied.iter().zip(&manifest.shard_hashes).map(|(shard, hash)| {
		shard.as_ref().filter(|bytes| bytes.len() == manifest.shard_len && blake2sum(bytes) == *hash).cloned()
	}).collect();
	let codec = ReedSolomon::new(manifest.data_shards, manifest.parity_shards).map_err(|e| e.to_string())?;
	codec.reconstruct(&mut shards).map_err(|e| e.to_string())?;
	let mut data = Vec::with_capacity(manifest.data_shards * manifest.shard_len);
	for (index, (shard, expected_hash)) in shards.iter().zip(&manifest.shard_hashes).enumerate() {
		let shard = shard.as_ref().ok_or("Reconstruction left a missing shard")?;
		if blake2sum(shard) != *expected_hash {
			return Err("Reconstructed shard failed integrity check".into());
		}
		if index < manifest.data_shards {
			data.extend_from_slice(shard);
		}
	}
	data.truncate(manifest.original_len);
	if blake2sum(&data) != manifest.data_hash {
		return Err("Reconstructed data failed integrity check".into());
	}
	shards.into_iter().map(|shard| shard.ok_or_else(|| "Reconstruction left a missing shard".to_string())).collect()
}

/// Recover the original data from validated and reconstructed shards.
pub fn recover(manifest: &StripeManifest, supplied: &[Option<Vec<u8>>]) -> Result<Vec<u8>, String> {
	let shards = reconstruct_shards(manifest, supplied)?;
	let mut data = Vec::with_capacity(manifest.data_shards * manifest.shard_len);
	for shard in shards.iter().take(manifest.data_shards) {
		data.extend_from_slice(shard);
	}
	data.truncate(manifest.original_len);
	Ok(data)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn recovers_every_two_shard_loss_in_a_four_plus_two_stripe() {
		for data in [vec![], vec![7], (0..251).map(|n| n as u8).collect()] {
			let (manifest, shards) = encode(&data, 4, 2).unwrap();
			for first in 0..6 {
				for second in (first + 1)..6 {
					let mut available: Vec<_> = shards.iter().cloned().map(Some).collect();
					available[first] = None;
					available[second] = None;
					assert_eq!(recover(&manifest, &available).unwrap(), data);
					assert_eq!(reconstruct_shards(&manifest, &available).unwrap(), shards);
				}
			}
		}
	}

	#[test]
	fn corruption_is_an_erasure_and_excess_damage_is_rejected() {
		let data = b"data is never accepted without integrity checks";
		let (manifest, shards) = encode(data, 4, 2).unwrap();
		let mut available: Vec<_> = shards.iter().cloned().map(Some).collect();
		available[0].as_mut().unwrap()[0] ^= 1;
		available[4] = None;
		assert_eq!(recover(&manifest, &available).unwrap(), data);
		available[3] = None;
		assert!(recover(&manifest, &available).is_err());
	}

	#[test]
	fn truncated_and_wrong_position_shards_are_not_accepted() {
		let data = b"shard positions are significant";
		let (manifest, shards) = encode(data, 4, 2).unwrap();
		let mut available: Vec<_> = shards.iter().cloned().map(Some).collect();
		available.swap(0, 1);
		assert_eq!(recover(&manifest, &available).unwrap(), data);
		available[2].as_mut().unwrap().pop();
		assert!(recover(&manifest, &available).is_err());
	}

	#[test]
	fn rejects_invalid_parameters_and_untrusted_metadata() {
		assert!(encode(b"x", 0, 2).is_err());
		assert!(encode(b"x", 2, 0).is_err());
		assert!(encode(b"x", usize::MAX, 2).is_err());
		assert!(encode(b"x", 16, 1).is_err());
		assert!(encode(&vec![0; MAX_STRIPE_BYTES + 1], 4, 2).is_err());
		let (mut manifest, shards) = encode(b"example", 4, 2).unwrap();
		let available: Vec<_> = shards.into_iter().map(Some).collect();
		assert!(recover(&manifest, &available[..5]).is_err());
		manifest.data_hash = blake2sum(b"not example");
		assert!(recover(&manifest, &available).is_err());
	}
}
