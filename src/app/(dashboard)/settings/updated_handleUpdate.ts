    async function handleUpdate(e: React.FormEvent) {
      e.preventDefault();
      setLoading(true);
      setError("");
      setSuccess("");

      if (!user) {
        setLoading(false);
        return;
      }

      // Update name in profiles table
      if (name) {
        const { error: nameError } = await supabase
          .from('profiles')
          .upsert({ id: user.id, name }, { onConflict: 'id' });
        if (nameError) {
          setError(nameError.message);
          setLoading(false);
          return;
        }
      }

      // Handle avatar upload if provided
      if (avatar) {
        try {
          // Delete old avatar from storage if exists
          const { data: oldProfile } = await supabase
            .from('profiles')
            .select('avatar_url')
            .eq('id', user.id)
            .maybeSingle();

          if (oldProfile?.avatar_url) {
            const oldFileName = oldProfile.avatar_url.split('/').pop();
            if (oldFileName && oldFileName.includes('.')) {
              await supabase.storage.from('avatars').remove([oldFileName]);
            }
          }

          const fileName = `${user.id}-${Date.now()}.jpg`;
          const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(fileName, avatar, { cacheControl: '3600', upsert: true });

          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage
            .from('avatars')
            .getPublicUrl(fileName);

          // Update profile with avatar URL
          const { error: profileError } = await supabase
            .from('profiles')
            .update({ avatar_url: publicUrl })
            .eq('id', user.id);

          if (profileError) throw profileError;

          // Reload profile data to update preview immediately
          const { data: updatedProfile } = await supabase
            .from('profiles')
            .select('avatar_url')
            .eq('id', user.id)
            .single();
          
          setAvatarPreview(updatedProfile?.avatar_url || null);
        } catch (uploadError) {
          setError(uploadError instanceof Error ? uploadError.message : "فشل رفع الصورة. يرجى المحاولة مرة أخرى.");
          setLoading(false);
          return;
        }
      }
      // Handle avatar removal
      else if (avatar === null && avatarPreview === null) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('id', user.id)
          .maybeSingle();

        if (profile?.avatar_url) {
          const fileName = profile.avatar_url.split('/').pop();
          if (fileName && fileName.includes('.')) {
            await supabase.storage.from('avatars').remove([fileName]);
          }
          await supabase.from('profiles').update({ avatar_url: null }).eq('id', user.id);
        }
      }

      setSuccess(t('settings.saved'));
      setLoading(false);
    }